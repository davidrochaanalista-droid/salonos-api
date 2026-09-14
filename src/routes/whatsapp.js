/**
 * SalonOS — Serviço de IA do WhatsApp com memória (v2)
 * =====================================================
 * Novidades desta versão:
 * 1. Cliente NOVO: fluxo determinístico pede nome e endereço antes
 *    de liberar a conversa livre (telefone já vem do WhatsApp).
 *    Aniversário é pedido de forma leve, não bloqueante — ver nota
 *    no README-fase1.md sobre essa decisão.
 * 2. Cliente EXISTENTE, em nova sessão de conversa (gap de tempo
 *    desde a última mensagem): a IA pergunta se é o mesmo
 *    procedimento com a mesma profissional de sempre, ou algo
 *    diferente — usando o histórico real de atendimentos, não
 *    "lembrança" da IA (que não é confiável para isso).
 */

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');
const evolution = require('../lib/evolution-api');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// 'llama-3.3-70b-versatile' saiu do catálogo do Groq (dava 404 -- achado
// em 10/09/2026 num outro projeto usando a mesma conta). Configurável via
// env var pra não repetir esse tipo de quebra se o catálogo mudar de novo.
const MODELO_IA = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

// Gap de tempo que caracteriza "nova conversa" (não continuação imediata)
// para disparar a pergunta de repetição de procedimento. Ajustável.
const SESSAO_GAP_HORAS = 4;

// ============================================================
// FERRAMENTAS DA IA (tool calling) -- a Groq é compatível com o formato
// OpenAI de function calling. Sem isso, a IA só gera texto e não pode
// realmente mudar nada no banco -- qualquer "vou atualizar seu cadastro"
// sem uma ferramenta de verdade por trás seria a IA mentindo pro cliente.
// ============================================================
const FERRAMENTAS_IA = [
  {
    type: 'function',
    function: {
      name: 'atualizar_cadastro_cliente',
      description: 'Corrige ou atualiza o nome, endereço e/ou data de nascimento do cliente já cadastrado, quando ele pedir explicitamente pra corrigir uma informação. Só chame com o(s) campo(s) que o cliente realmente pediu pra mudar.',
      parameters: {
        type: 'object',
        properties: {
          nome: { type: 'string', description: 'Nome corrigido, só se o cliente pediu pra mudar o nome.' },
          endereco: { type: 'string', description: 'Endereço corrigido, só se o cliente pediu pra mudar o endereço.' },
          data_nascimento: { type: 'string', description: 'Data de nascimento no formato YYYY-MM-DD, só se o cliente informou ou corrigiu.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'registrar_solicitacao_agendamento',
      description: 'Registra um pedido de agendamento feito com o estabelecimento fechado (fora do horário de funcionamento), pra equipe confirmar assim que abrir. Só chame depois de já saber qual serviço o cliente quer e a preferência de dia/horário dele.',
      parameters: {
        type: 'object',
        properties: {
          nome_servico: { type: 'string', description: 'Nome do serviço desejado, o mais próximo possível de um dos serviços oferecidos.' },
          pedido_cliente: { type: 'string', description: 'O que o cliente pediu, em texto natural (ex: "sábado de manhã", "quinta às 15h").' },
          data_hora_solicitada: { type: 'string', description: 'Se der pra entender uma data/hora exata do pedido do cliente, formato ISO 8601 (YYYY-MM-DDTHH:MM:SS), considerando o fuso de Brasília. Deixe vazio se não for possível saber uma data/hora exata (ex: cliente só disse "qualquer dia da semana que vem").' },
        },
        required: ['pedido_cliente'],
      },
    },
  },
];

async function executarFerramentaIA(chamada, contexto) {
  let argumentos;
  try {
    argumentos = JSON.parse(chamada.function?.arguments || '{}');
  } catch {
    return { ok: false, motivo: 'argumentos inválidos' };
  }

  if (chamada.function?.name === 'atualizar_cadastro_cliente') {
    const camposPermitidos = ['nome', 'endereco', 'data_nascimento'];
    const atualizacoes = {};
    for (const campo of camposPermitidos) {
      if (argumentos[campo]) atualizacoes[campo] = argumentos[campo];
    }
    if (!Object.keys(atualizacoes).length) return { ok: false, motivo: 'nenhum campo válido pra atualizar' };

    const { error } = await supabase.from('clientes').update(atualizacoes).eq('id', contexto.cliente.id);
    if (error) return { ok: false, motivo: error.message };
    return { ok: true, atualizado: atualizacoes };
  }

  if (chamada.function?.name === 'registrar_solicitacao_agendamento') {
    if (!argumentos.pedido_cliente) return { ok: false, motivo: 'pedido_cliente é obrigatório' };

    const atividade = (contexto.atividades || []).find(a => a.nome.toLowerCase() === (argumentos.nome_servico || '').toLowerCase())
      || (contexto.atividades || []).find(a => a.nome.toLowerCase().includes((argumentos.nome_servico || '').toLowerCase()));

    const { error } = await supabase.from('solicitacoes_agendamento').insert({
      estabelecimento_id: contexto.estabelecimentoId,
      cliente_id: contexto.cliente.id,
      estabelecimento_atividade_id: atividade?.id || null,
      pedido_cliente: argumentos.pedido_cliente,
      data_hora_solicitada: argumentos.data_hora_solicitada || null,
    });
    if (error) return { ok: false, motivo: error.message };
    return { ok: true, registrado: true };
  }

  return { ok: false, motivo: 'ferramenta desconhecida' };
}

// Saudação por horário, sempre no fuso de Brasília (independe de onde o
// servidor roda -- Railway não necessariamente está em horário do Brasil).
function saudacaoPorHorario() {
  const hora = Number(new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', hour12: false, timeZone: 'America/Sao_Paulo' }).format(new Date()));
  if (hora < 12) return 'Bom dia';
  if (hora < 18) return 'Boa tarde';
  return 'Boa noite';
}

const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];

// Estabelecimento está aberto agora? Sempre no fuso de Brasília. Não
// bloqueia o atendimento se fechado -- só informa isso pra IA usar no
// tom da resposta (ver instrução em montarSystemPrompt), pra nunca perder
// o cliente que manda mensagem fora do horário.
function estaAberto(estabelecimento) {
  const agoraSP = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const diaHoje = DIAS_SEMANA[agoraSP.getDay()];
  if (!estabelecimento.dias_funcionamento?.includes(diaHoje)) return false;

  const horaAtual = agoraSP.getHours() * 60 + agoraSP.getMinutes();
  const [horaAbre, minAbre] = (estabelecimento.horario_abertura || '00:00').split(':').map(Number);
  const [horaFecha, minFecha] = (estabelecimento.horario_fechamento || '23:59').split(':').map(Number);
  return horaAtual >= horaAbre * 60 + minAbre && horaAtual < horaFecha * 60 + minFecha;
}

// ============================================================
// SYSTEM PROMPT
// ============================================================
function montarSystemPrompt({ estabelecimento, atividades, memoriaCliente, instrucaoExtra, nomeCliente }) {
  const listaAtividades = atividades
    .map(a => `- ${a.nome}${a.preco ? ` (${a.preco_variavel ? 'a partir de ' : ''}R$ ${a.preco})` : ''}${a.duracao_min ? `, ${a.duracao_min}min` : ''}`)
    .join('\n');

  const aberto = estaAberto(estabelecimento);
  const primeiroNome = nomeCliente?.split(' ')[0];

  return `Você é a atendente virtual do ${estabelecimento.nome}, um estabelecimento do segmento "${estabelecimento.segmento_nome}", conversando pelo WhatsApp do negócio. Agora, no horário de Brasília, é hora de dizer "${saudacaoPorHorario()}" -- use essa saudação (ou uma variação natural dela) se for cumprimentar o cliente agora, mas só no início da conversa, não repita em toda mensagem. ${primeiroNome ? `Esse cliente já é cadastrado e se chama ${primeiroNome} -- chame-o pelo primeiro nome ao cumprimentar (ex: "${saudacaoPorHorario()}, ${primeiroNome}!"), nunca pergunte o nome de novo.` : ''}

${aberto ? '' : `IMPORTANTE -- FORA DO HORÁRIO DE FUNCIONAMENTO: agora o estabelecimento está fechado (funciona ${estabelecimento.horario_abertura?.slice(0,5)} às ${estabelecimento.horario_fechamento?.slice(0,5)}). Avise isso ao cliente de forma leve, uma vez, sem soar como bloqueio -- e continue o atendimento normalmente. Nunca pare de ajudar só porque está fechado: se o assunto for agendamento, colete o serviço desejado e a preferência de dia/horário do cliente naturalmente na conversa, e assim que tiver essas duas informações, chame a ferramenta registrar_solicitacao_agendamento (nunca diga que "já agendou" ou "está confirmado" -- diga que a equipe confirma assim que abrir). Não perca o cliente por estar fora do horário.`}

REGRAS DE TOM (sempre):
- Português do Brasil, cordial e caloroso, mas objetivo — nada de resposta robótica nem parágrafo longo. Pode usar "oi", "tudo bem?" naturalmente, mas sem gíria regional pesada (nunca "oxe", "bah", "mano", "cê").
- No máximo 1 emoji por mensagem, só quando fizer sentido — nunca em toda frase.
- Mensagens curtas, como uma pessoa digitaria no WhatsApp. Se a resposta tiver mais de uma ideia, separe cada ideia num parágrafo próprio (linha em branco entre elas) -- cada parágrafo vira uma mensagem separada de verdade, então não quebre uma frase no meio.
- Você é a atendente automatizada do negócio -- não é preciso anunciar isso a cada mensagem, mas nunca negue ou esconda se o cliente perguntar direta ou indiretamente.
- Nunca invente preço, horário ou serviço fora da lista abaixo.
- Se não tiver certeza de algo, diga com honestidade que vai confirmar com a equipe -- nunca invente pra parecer seguro.
- Se não entender a mensagem, peça esclarecimento com gentileza (ex: "só pra eu entender direitinho, você quer dizer...?"), nunca de forma seca.
- Se o cliente pedir pra parar de receber mensagens ou demonstrar desinteresse, respeite na hora, sem insistir nem repetir a pergunta.
- Se o cliente pedir pra corrigir nome, endereço ou data de nascimento, use a ferramenta atualizar_cadastro_cliente disponível -- nunca diga que corrigiu ou salvou algo sem realmente chamar a ferramenta.

SERVIÇOS OFERECIDOS:
${listaAtividades}

HORÁRIO: ${estabelecimento.horario_abertura} às ${estabelecimento.horario_fechamento}, ${estabelecimento.dias_funcionamento.join(', ')}

${memoriaCliente?.resumo ? `SOBRE ESTE CLIENTE (use com naturalidade, não repita como lista):\n${memoriaCliente.resumo}` : ''}

${instrucaoExtra || ''}`;
}

// ============================================================
// WEBHOOK PRINCIPAL
// ============================================================
router.post('/webhook/whatsapp/:estabelecimentoId', async (req, res) => {
  try {
    const { estabelecimentoId } = req.params;

    // Evento de status de conexão da instância (QR escaneado, desconexão
    // etc.) -- é assim que estabelecimentos.whatsapp_status/whatsapp_numero
    // ficam sincronizados sem o front precisar bater na Evolution API direto.
    if (req.body?.event === 'connection.update') {
      await tratarAtualizacaoConexao(estabelecimentoId, req.body?.data);
      return res.sendStatus(200);
    }

    const { telefone, mensagem } = extrairMensagem(req.body);

    // Ignora eventos sem texto (confirmação de leitura, status, mensagem de
    // grupo etc.) -- não é o webhook de mensagem de cliente que interessa.
    if (!telefone || !mensagem) return res.sendStatus(200);

    const { data: estabelecimento } = await supabase
      .from('estabelecimentos')
      .select('*, segmentos(nome)')
      .eq('id', estabelecimentoId)
      .single();

    const { data: atividades } = await supabase
      .from('estabelecimento_atividades')
      .select('id, nome, preco, preco_variavel, duracao_min')
      .eq('estabelecimento_id', estabelecimentoId)
      .eq('ativo', true);

    let { data: cliente } = await supabase
      .from('clientes')
      .select('*')
      .eq('estabelecimento_id', estabelecimentoId)
      .eq('telefone', telefone)
      .maybeSingle();

    const clienteEhNovo = !cliente;
    if (clienteEhNovo) {
      const { data: novoCliente } = await supabase
        .from('clientes')
        .insert({ estabelecimento_id: estabelecimentoId, telefone, estado_onboarding: 'novo' })
        .select()
        .single();
      cliente = novoCliente;
    }

    // ── 1. FLUXO DE ONBOARDING (cliente novo, dados obrigatórios) ──
    if (cliente.estado_onboarding !== 'completo') {
      const respostaTexto = await processarOnboarding({ cliente, mensagem, estabelecimento });
      await registrarMensagens({ estabelecimentoId, clienteId: cliente.id, mensagem, respostaTexto });
      await enviarMensagemWhatsApp({ telefone, texto: respostaTexto, estabelecimentoId });
      return res.sendStatus(200);
    }

    // ── 1.5 RESPOSTA A UMA PROPOSTA DE HORÁRIO PENDENTE ──
    // Se a equipe propôs um horário alternativo e está esperando resposta,
    // essa mensagem é tratada como resposta a essa proposta (em linguagem
    // natural, nunca exigindo "sim"/"não" literal), não como assunto novo.
    const { data: solicitacaoPendente } = await supabase
      .from('solicitacoes_agendamento')
      .select('*, estabelecimento_atividades(nome, duracao_min)')
      .eq('cliente_id', cliente.id)
      .eq('status', 'horario_proposto')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (solicitacaoPendente) {
      const respostaTexto = await tratarRespostaPropostaHorario({ solicitacaoPendente, mensagem, cliente, estabelecimentoId });
      await registrarMensagens({ estabelecimentoId, clienteId: cliente.id, mensagem, respostaTexto });
      await enviarMensagemWhatsApp({ telefone, texto: respostaTexto, estabelecimentoId });
      return res.sendStatus(200);
    }

    // ── 2. CLIENTE COMPLETO — checa se é nova sessão + busca último atendimento ──
    const horasDesdeUltimaInteracao = (Date.now() - new Date(cliente.ultima_interacao_em).getTime()) / 3600000;
    let instrucaoExtra = '';

    if (horasDesdeUltimaInteracao >= SESSAO_GAP_HORAS) {
      const { data: ultimoAtendimento } = await supabase
        .from('atendimentos')
        .select('data_atendimento, estabelecimento_atividades(nome), profissionais(nome)')
        .eq('cliente_id', cliente.id)
        .order('data_atendimento', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (ultimoAtendimento) {
        const nomeAtividade = ultimoAtendimento.estabelecimento_atividades?.nome || 'o procedimento anterior';
        const nomeProfissional = ultimoAtendimento.profissionais?.nome || 'a mesma profissional de antes';
        instrucaoExtra = `IMPORTANTE PARA ESTA RESPOSTA: esta é uma nova conversa com um cliente já conhecido. Da última vez, ele fez "${nomeAtividade}" com ${nomeProfissional}. Antes de tratar de qualquer outro assunto, pergunte de forma natural e simpática se ele quer repetir o mesmo procedimento com a mesma profissional, ou se prefere fazer algo diferente desta vez. Não assuma a resposta — espere ele confirmar.`;
      }
    }

    // ── 3. Memória + histórico curto de mensagens ──
    const { data: memoriaCliente } = await supabase
      .from('whatsapp_memoria_cliente')
      .select('*')
      .eq('cliente_id', cliente.id)
      .maybeSingle();

    const { data: ultimasMensagens } = await supabase
      .from('whatsapp_mensagens')
      .select('direcao, conteudo')
      .eq('cliente_id', cliente.id)
      .order('created_at', { ascending: false })
      .limit(10);

    const historico = (ultimasMensagens || []).reverse().map(m => ({
      role: m.direcao === 'recebida' ? 'user' : 'assistant',
      content: m.conteudo,
    }));

    const systemPrompt = montarSystemPrompt({
      estabelecimento: { ...estabelecimento, segmento_nome: estabelecimento.segmentos.nome },
      atividades: atividades || [],
      memoriaCliente,
      instrucaoExtra,
      nomeCliente: cliente.nome,
    });

    const mensagensIA = [{ role: 'system', content: systemPrompt }, ...historico, { role: 'user', content: mensagem }];

    let resposta = await groq.chat.completions.create({
      model: MODELO_IA,
      messages: mensagensIA,
      temperature: 0.6,
      max_tokens: 400,
      tools: FERRAMENTAS_IA,
    });

    let mensagemResposta = resposta.choices[0].message;

    // A IA pediu pra executar uma ação de verdade (ex: corrigir o nome
    // salvo) -- roda no nosso código, devolve o resultado real pra ela, e
    // só então gera o texto final. Sem isso, a IA só teria como "dizer"
    // que atualizou sem nunca ter mudado nada no banco.
    if (mensagemResposta.tool_calls?.length) {
      mensagensIA.push(mensagemResposta);
      for (const chamada of mensagemResposta.tool_calls) {
        const resultado = await executarFerramentaIA(chamada, { cliente, atividades: atividades || [], estabelecimentoId });
        mensagensIA.push({ role: 'tool', tool_call_id: chamada.id, content: JSON.stringify(resultado) });
      }
      resposta = await groq.chat.completions.create({
        model: MODELO_IA,
        messages: mensagensIA,
        temperature: 0.6,
        max_tokens: 400,
      });
      mensagemResposta = resposta.choices[0].message;
    }

    const respostaTexto = mensagemResposta.content;
    await registrarMensagens({ estabelecimentoId, clienteId: cliente.id, mensagem, respostaTexto });

    const totalInteracoes = (memoriaCliente?.total_interacoes || 0) + 1;
    if (totalInteracoes % 6 === 0) {
      await atualizarMemoria({ estabelecimentoId, clienteId: cliente.id, memoriaAtual: memoriaCliente });
    } else {
      await supabase.from('whatsapp_memoria_cliente').upsert(
        { estabelecimento_id: estabelecimentoId, cliente_id: cliente.id, resumo: memoriaCliente?.resumo || '', total_interacoes: totalInteracoes, ultima_atualizacao: new Date().toISOString() },
        { onConflict: 'cliente_id' }
      );
    }

    await supabase.from('clientes').update({ ultima_interacao_em: new Date().toISOString() }).eq('id', cliente.id);
    await enviarRespostaIA({ telefone, texto: respostaTexto, estabelecimentoId });

    res.sendStatus(200);
  } catch (erro) {
    console.error('Erro no webhook WhatsApp:', erro);
    res.sendStatus(500);
  }
});

// ============================================================
// ONBOARDING DETERMINÍSTICO — nome, endereço, (aniversário opcional)
// Telefone já é conhecido automaticamente pelo número do WhatsApp.
// ============================================================
async function processarOnboarding({ cliente, mensagem, estabelecimento }) {
  switch (cliente.estado_onboarding) {
    case 'novo': {
      await supabase.from('clientes').update({ estado_onboarding: 'aguardando_nome' }).eq('id', cliente.id);
      return `${saudacaoPorHorario()}! Seja bem-vindo ao ${estabelecimento.nome} 😊 Para começar, qual é o seu nome completo?`;
    }

    case 'aguardando_nome': {
      const nome = await extrairCampoComIA(mensagem, 'nome completo da pessoa');
      await supabase.from('clientes').update({ nome, estado_onboarding: 'aguardando_endereco' }).eq('id', cliente.id);
      return `Prazer, ${nome.split(' ')[0]}! Agora me conta seu endereço — usamos isso só para ocasiões especiais, como enviar uma lembrança de aniversário.`;
    }

    case 'aguardando_endereco': {
      const endereco = await extrairCampoComIA(mensagem, 'endereço completo');
      await supabase.from('clientes').update({ endereco, estado_onboarding: 'completo' }).eq('id', cliente.id);
      return `Perfeito, já está tudo registrado! Se quiser, pode me contar depois a sua data de nascimento — assim conseguimos lembrar de você em datas especiais. E agora, me diz: como posso te ajudar hoje?`;
    }

    default:
      await supabase.from('clientes').update({ estado_onboarding: 'completo' }).eq('id', cliente.id);
      return 'Como posso te ajudar?';
  }
}

async function extrairCampoComIA(mensagemBruta, descricaoCampo) {
  try {
    const resposta = await groq.chat.completions.create({
      model: MODELO_IA,
      messages: [
        { role: 'system', content: `Extraia apenas o(a) ${descricaoCampo} da mensagem do usuário. Responda só com o valor extraído, sem frase, sem pontuação extra.` },
        { role: 'user', content: mensagemBruta },
      ],
      temperature: 0,
      max_tokens: 60,
    });
    const valor = resposta.choices[0].message.content.trim();
    return valor || mensagemBruta.trim();
  } catch {
    return mensagemBruta.trim();
  }
}

// ============================================================
// MEMÓRIA (resumo vivo, atualizado a cada 6 interações)
// ============================================================
async function atualizarMemoria({ estabelecimentoId, clienteId, memoriaAtual }) {
  const { data: mensagensRecentes } = await supabase
    .from('whatsapp_mensagens')
    .select('direcao, conteudo')
    .eq('cliente_id', clienteId)
    .order('created_at', { ascending: false })
    .limit(20);

  const transcricao = (mensagensRecentes || []).reverse()
    .map(m => `${m.direcao === 'recebida' ? 'Cliente' : 'Assistente'}: ${m.conteudo}`)
    .join('\n');

  const resumoAnterior = memoriaAtual?.resumo || '(nenhum resumo anterior)';

  const resposta = await groq.chat.completions.create({
    model: MODELO_IA,
    messages: [
      { role: 'system', content: `Você atualiza um resumo curto (máximo 4 frases) sobre um cliente de um estabelecimento de beleza, para uso interno da IA de atendimento. Não invente informação. Foque em: preferências de serviço, horários que costuma escolher, alguma restrição ou observação relevante mencionada espontaneamente, e frequência de contato. Nunca inclua dado de saúde sensível além do que o próprio cliente disse.` },
      { role: 'user', content: `Resumo anterior: ${resumoAnterior}\n\nConversa recente:\n${transcricao}\n\nGere o resumo atualizado, em português, sem gíria, direto.` },
    ],
    temperature: 0.3,
    max_tokens: 200,
  });

  const novoResumo = resposta.choices[0].message.content.trim();

  await supabase.from('whatsapp_memoria_cliente').upsert(
    { estabelecimento_id: estabelecimentoId, cliente_id: clienteId, resumo: novoResumo, total_interacoes: (memoriaAtual?.total_interacoes || 0) + 1, ultima_atualizacao: new Date().toISOString() },
    { onConflict: 'cliente_id' }
  );
}

// ============================================================
// SOLICITAÇÃO DE AGENDAMENTO — resposta do cliente a uma proposta de
// horário alternativo (feita pela equipe pelo painel, ver
// routes/solicitacoes-agendamento.js). Sempre interpretada em linguagem
// natural pela IA -- nunca exige "sim"/"não" literal do cliente.
// ============================================================
const FERRAMENTA_RESPOSTA_PROPOSTA = [
  {
    type: 'function',
    function: {
      name: 'responder_proposta_horario',
      description: 'Registra se o cliente aceitou ou não o horário alternativo proposto pelo salão, com base na resposta em linguagem natural dele.',
      parameters: {
        type: 'object',
        properties: {
          aceitou: { type: 'boolean', description: 'true se o cliente aceitou o horário proposto, false se recusou ou quer outro horário.' },
          novo_pedido: { type: 'string', description: 'Se recusou e sugeriu outra preferência de dia/horário, registre aqui. Deixe vazio se não sugeriu nada.' },
        },
        required: ['aceitou'],
      },
    },
  },
];

async function tratarRespostaPropostaHorario({ solicitacaoPendente, mensagem, cliente, estabelecimentoId }) {
  const dataFormatada = new Date(solicitacaoPendente.data_hora_proposta).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });

  // A Groq com tool_choice:'required' já se mostrou instável em teste real
  // (às vezes gera JSON malformado, às vezes não chama a ferramenta) -- se
  // isso falhar, NUNCA travamos o cliente sem resposta nem assumimos
  // "recusou" sem saber: respondemos com honestidade que a equipe vai
  // confirmar, e deixamos a solicitação como está (horario_proposto) pra
  // alguém revisar manualmente a conversa.
  let aceitou = null;
  let novoPedido = '';
  for (let tentativa = 0; tentativa < 2 && aceitou === null; tentativa++) {
    try {
      const resposta = await groq.chat.completions.create({
        model: MODELO_IA,
        messages: [
          { role: 'system', content: `Você está avaliando a resposta de um cliente a uma proposta de horário alternativo pro serviço "${solicitacaoPendente.estabelecimento_atividades?.nome || 'atendimento'}", proposto pra ${dataFormatada}. Use a ferramenta responder_proposta_horario pra registrar se ele aceitou ou não, com base na mensagem dele -- que pode vir em qualquer forma natural (nunca exija "sim"/"não" literal).` },
          { role: 'user', content: mensagem },
        ],
        tools: FERRAMENTA_RESPOSTA_PROPOSTA,
        tool_choice: 'required',
        temperature: 0.2,
        max_tokens: 150,
      });
      const chamada = resposta.choices[0].message.tool_calls?.[0];
      const argumentos = JSON.parse(chamada.function.arguments);
      aceitou = !!argumentos.aceitou;
      novoPedido = argumentos.novo_pedido || '';
    } catch (erro) {
      console.error(`Falha ao interpretar resposta de proposta de horário (tentativa ${tentativa + 1}):`, erro.message);
    }
  }

  const primeiroNome = cliente.nome?.split(' ')[0] || '';

  if (aceitou === null) {
    return `Entendi${primeiroNome ? ', ' + primeiroNome : ''}! Vou confirmar isso com a equipe e já te retorno por aqui.`;
  }

  if (aceitou) {
    const duracaoMin = solicitacaoPendente.estabelecimento_atividades?.duracao_min || 60;
    const inicio = new Date(solicitacaoPendente.data_hora_proposta);
    const fim = new Date(inicio.getTime() + duracaoMin * 60000);

    const { data: agendamento, error: errAgendamento } = await supabase
      .from('agendamentos')
      .insert({
        estabelecimento_id: estabelecimentoId,
        cliente_id: cliente.id,
        estabelecimento_atividade_id: solicitacaoPendente.estabelecimento_atividade_id,
        inicio: inicio.toISOString(),
        fim: fim.toISOString(),
        origem: 'whatsapp',
        observacao: 'Horário alternativo proposto pela equipe, aceito pelo cliente.',
      })
      .select()
      .single();

    if (errAgendamento) {
      console.error('Falha ao criar agendamento a partir de proposta aceita:', errAgendamento.message);
      return 'Tive um problema aqui pra confirmar seu horário. Já vou chamar a equipe pra resolver com você, tá bem?';
    }

    await supabase.from('solicitacoes_agendamento').update({ status: 'confirmado', agendamento_id: agendamento.id }).eq('id', solicitacaoPendente.id);
    return `${primeiroNome ? primeiroNome + ', que' : 'Que'} bom! Ficou confirmado pra ${dataFormatada} então 😊 Te esperamos por aqui!`;
  }

  const pedidoAtualizado = novoPedido ? `${solicitacaoPendente.pedido_cliente} / cliente recusou o horário proposto e sugeriu: ${novoPedido}` : `${solicitacaoPendente.pedido_cliente} / cliente recusou o horário proposto (${dataFormatada})`;
  await supabase.from('solicitacoes_agendamento').update({ status: 'pendente', pedido_cliente: pedidoAtualizado, data_hora_proposta: null }).eq('id', solicitacaoPendente.id);
  return `Entendi${primeiroNome ? ', ' + primeiroNome : ''}! Vou avisar a equipe pra ver outro horário que funcione melhor pra você. Assim que tiver uma opção, te aviso por aqui.`;
}

// Mensagem enviada quando a equipe propõe um horário alternativo pelo
// painel -- gerada pela IA (mesmo tom do resto do atendimento), não é
// um template fixo tipo "responda sim ou não".
async function gerarMensagemPropostaHorario({ nomeCliente, nomeServico, dataHoraProposta }) {
  const dataFormatada = new Date(dataHoraProposta).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  const primeiroNome = nomeCliente?.split(' ')[0] || '';

  try {
    const resposta = await groq.chat.completions.create({
      model: MODELO_IA,
      messages: [
        { role: 'system', content: 'Você é a atendente virtual de um salão, escrevendo pelo WhatsApp. Tom cordial e caloroso, mensagem curta (2-3 frases), no máximo 1 emoji. Nunca peça "responda sim ou não" -- escreva como uma pessoa perguntaria naturalmente se aquele horário funciona.' },
        { role: 'user', content: `Escreva uma mensagem${primeiroNome ? ' pra ' + primeiroNome : ''} avisando que o horário que pediu não estava disponível, mas propondo ${dataFormatada} pra "${nomeServico || 'o atendimento'}", perguntando se funciona pra ela(e).` },
      ],
      temperature: 0.6,
      max_tokens: 150,
    });
    return resposta.choices[0].message.content;
  } catch (erro) {
    console.error('Falha ao gerar mensagem de proposta de horário, usando texto padrão:', erro.message);
    return `${primeiroNome ? primeiroNome + ', o' : 'O'} horário que você pediu não estava disponível, mas que tal ${dataFormatada} pra ${nomeServico || 'o atendimento'}? Me avisa se funciona pra você!`;
  }
}

// ============================================================
// AUXILIARES
// ============================================================
async function registrarMensagens({ estabelecimentoId, clienteId, mensagem, respostaTexto }) {
  await supabase.from('whatsapp_mensagens').insert([
    { estabelecimento_id: estabelecimentoId, cliente_id: clienteId, direcao: 'recebida', conteudo: mensagem },
    { estabelecimento_id: estabelecimentoId, cliente_id: clienteId, direcao: 'enviada', conteudo: respostaTexto, modelo_ia: MODELO_IA },
  ]);
}

// Payload do webhook da Evolution API (evento "messages.upsert", formato v2).
// Ver README-fase1.md, seção 3 -- decisão pelo Evolution API (self-hosted).
function extrairMensagem(body) {
  const dado = body?.data;
  if (!dado || body?.event !== 'messages.upsert') return { telefone: null, mensagem: null };

  // Ignora eco da própria mensagem enviada pelo bot e mensagens de grupo.
  if (dado.key?.fromMe) return { telefone: null, mensagem: null };
  const remoteJid = dado.key?.remoteJid || '';
  if (remoteJid.endsWith('@g.us')) return { telefone: null, mensagem: null };

  const texto = dado.message?.conversation
    || dado.message?.extendedTextMessage?.text
    || null;

  return { telefone: remoteJid.replace('@s.whatsapp.net', ''), mensagem: texto };
}

// estabelecimentoId define QUAL instância (QUAL número de WhatsApp) envia a
// mensagem -- ver src/lib/evolution-api.js. Nunca lança: todo chamador aqui
// é fire-and-forget (webhook de IA, gatilho de automação, avaliação pós-
// atendimento) e uma falha de envio não pode derrubar o fluxo principal.
async function enviarMensagemWhatsApp({ telefone, texto, estabelecimentoId }) {
  if (!estabelecimentoId) {
    console.error('enviarMensagemWhatsApp chamado sem estabelecimentoId -- mensagem NÃO enviada.');
    return;
  }
  if (!evolution.evolutionConfigurada()) {
    console.error('EVOLUTION_API_URL/EVOLUTION_API_KEY não configurados -- mensagem NÃO enviada.');
    return;
  }

  try {
    await evolution.enviarTexto(estabelecimentoId, telefone, texto);
  } catch (erro) {
    console.error('Falha ao enviar WhatsApp via Evolution API:', erro.message);
  }
}

// Resposta livre da IA pode ter mais de uma ideia -- o prompt já instrui a
// separar cada ideia num parágrafo (linha em branco), aqui cada parágrafo
// vira uma mensagem de WhatsApp de verdade em sequência, como uma pessoa
// digitando várias mensagens curtas em vez de um bloco só de texto.
async function enviarRespostaIA({ telefone, texto, estabelecimentoId }) {
  const partes = texto.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  for (const parte of partes) {
    await enviarMensagemWhatsApp({ telefone, texto: parte, estabelecimentoId });
  }
}

// Mantém estabelecimentos.whatsapp_status/whatsapp_numero sincronizados com
// o estado real da instância. Payload de "connection.update" na Evolution
// API v2 (de memória, não verificado): { state: 'open'|'connecting'|'close',
// ...outros campos dependendo da versão }. O número conectado normalmente só
// fica disponível depois que o estado vira "open" -- consultamos a própria
// Evolution API pra pegar o número nesse momento, em vez de confiar no
// payload do webhook (formato desse campo específico não está confirmado).
async function tratarAtualizacaoConexao(estabelecimentoId, dados) {
  const estado = dados?.state;
  const mapaStatus = { open: 'conectado', connecting: 'conectando', close: 'desconectado' };
  const novoStatus = mapaStatus[estado] || 'desconectado';

  const atualizacoes = { whatsapp_status: novoStatus };
  if (novoStatus === 'conectado') {
    // Nome do campo com o número conectado não está confirmado nessa versão
    // da Evolution API -- tentamos os formatos mais comuns e deixamos null
    // se nenhum bater (a UI só usa isso pra exibição, não é crítico).
    const jid = dados?.wuid || dados?.owner || dados?.number || null;
    atualizacoes.whatsapp_numero = jid ? jid.replace('@s.whatsapp.net', '') : null;
  } else {
    atualizacoes.whatsapp_numero = null;
  }

  await supabase.from('estabelecimentos').update(atualizacoes).eq('id', estabelecimentoId);
}

module.exports = router;
module.exports.enviarMensagemWhatsApp = enviarMensagemWhatsApp;
module.exports.gerarMensagemPropostaHorario = gerarMensagemPropostaHorario;
