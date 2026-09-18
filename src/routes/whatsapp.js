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
const { randomUUID } = require('crypto');
const evolution = require('../lib/evolution-api');
const { buscarHorariosDisponiveis } = require('../lib/disponibilidade');
const { registrarAcessoAuditoria } = require('../lib/auditoria');
const { gerarCopiaECola } = require('../lib/pix');
const { confirmarSolicitacaoAgendamento } = require('../lib/agendamento-confirmacao');

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

// Mais de quantas faltas (agendamentos com status "nao_compareceu") o
// cliente precisa acumular antes da IA passar a exigir sinal antecipado
// pra confirmar o próximo agendamento. Ajustável.
const LIMITE_FALTAS_SINAL = 2;

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
      description: 'Corrige ou atualiza o nome, endereço e/ou aniversário do cliente já cadastrado, quando ele pedir explicitamente pra corrigir uma informação. Só chame com o(s) campo(s) que o cliente realmente pediu pra mudar.',
      parameters: {
        type: 'object',
        properties: {
          nome: { type: 'string', description: 'Nome corrigido, só se o cliente pediu pra mudar o nome.' },
          endereco: { type: 'string', description: 'Endereço corrigido, só se o cliente pediu pra mudar o endereço.' },
          data_nascimento: { type: 'string', description: 'Dia e mês de aniversário no formato MM-DD (ex: "03-25" pra 25 de março) -- nunca peça nem registre o ano, só interessa a data pra parabenizar. Só preencha se o cliente informou ou corrigiu.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'registrar_solicitacao_agendamento',
      description: 'Registra um pedido de agendamento pra equipe revisar manualmente, sem confirmar nada na hora. Use só quando buscar_horarios_disponiveis não achar nenhum horário livre na semana, ou quando o cliente insistir num dia/horário específico que já está ocupado e não topar nenhuma das alternativas livres encontradas. Pode registrar mais de um serviço de uma vez, se o cliente pedir vários na mesma visita (ex: unhas, cabelo e depilação). Só chame depois de já saber quais serviços o cliente quer e a preferência de dia/horário dele -- e depois de perguntar naturalmente se ele tem preferência de profissional por serviço ou se tanto faz.',
      parameters: {
        type: 'object',
        properties: {
          servicos: {
            type: 'array',
            minItems: 1,
            description: 'Lista dos serviços pedidos, na ordem que o cliente quer fazer na visita.',
            items: {
              type: 'object',
              properties: {
                nome_servico: { type: 'string', description: 'Nome de um serviço real da lista de serviços oferecidos (nunca um termo genérico tipo "serviço" ou "atendimento") -- se não souber qual exatamente o cliente quer, não chame essa ferramenta, pergunte antes.' },
                nome_profissional: { type: 'string', description: 'Nome da profissional que o cliente prefere pra esse serviço, só se ele mencionou. Deixe vazio se tanto faz.' },
              },
              required: ['nome_servico'],
            },
          },
          pedido_cliente: { type: 'string', description: 'O que o cliente pediu, em texto natural (ex: "sábado de manhã", "quinta às 15h").' },
          data_hora_solicitada: { type: 'string', description: 'Se der pra entender uma data/hora exata do pedido do cliente, formato ISO 8601 (YYYY-MM-DDTHH:MM:SS), considerando o fuso de Brasília. Deixe vazio se não for possível saber uma data/hora exata (ex: cliente só disse "qualquer dia da semana que vem").' },
        },
        required: ['servicos', 'pedido_cliente'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_horarios_disponiveis',
      description: 'Busca de verdade um horário e profissional livres pro(s) serviço(s) que o cliente quer -- encaixando todos na mesma visita, em sequência. Funciona igual com o estabelecimento aberto ou fechado agora (a busca já considera só os dias/horários de funcionamento certos, nunca propõe um horário fora deles). Só chame depois de já saber quais serviços o cliente quer e ter perguntado naturalmente se ele tem preferência de profissional por serviço ou se tanto faz. Nunca invente horário -- só use o que essa ferramenta devolver de verdade.',
      parameters: {
        type: 'object',
        properties: {
          servicos: {
            type: 'array',
            minItems: 1,
            description: 'Lista dos serviços pedidos, na ordem que o cliente quer fazer na visita.',
            items: {
              type: 'object',
              properties: {
                nome_servico: { type: 'string', description: 'Nome de um serviço real da lista de serviços oferecidos (nunca um termo genérico tipo "serviço" ou "atendimento") -- se não souber qual exatamente o cliente quer, não chame essa ferramenta, pergunte antes.' },
                nome_profissional: { type: 'string', description: 'Nome da profissional que o cliente prefere pra esse serviço, só se ele mencionou. Deixe vazio se tanto faz.' },
              },
              required: ['nome_servico'],
            },
          },
          data_preferida: { type: 'string', description: 'Data preferida do cliente, formato YYYY-MM-DD, se ele mencionou uma. Deixe vazio se não mencionou (a busca já procura a partir de hoje).' },
        },
        required: ['servicos'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'enviar_chave_pix',
      description: 'Gera o Pix Copia-e-Cola (chave/QR) de verdade pro cliente pagar adiantado, usando a chave cadastrada pelo estabelecimento. Sem parâmetros -- o sistema já sabe qual é o estabelecimento. Só chame quando o cliente topar pagar adiantado.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

// Converte "MM-DD" (o formato pedido à IA) numa data completa pra guardar
// em clientes.data_nascimento (coluna DATE, exige ano) -- o ano é sempre
// um placeholder fixo (2000, bissexto, cobre 29/02 sem erro), porque
// verificarAniversario() (scheduler.js) só compara mês/dia, nunca usa o
// ano pra calcular idade. Aceita também "DD-MM" por engano da IA (detecta
// pelo primeiro número > 12, que só é possível sendo dia).
function formatarAniversario(valor) {
  const match = String(valor).trim().match(/^(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;
  const [, a, b] = match;
  const mes = Number(a) > 12 ? Number(b) : Number(a);
  const dia = Number(a) > 12 ? Number(a) : Number(b);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  return `2000-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

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

    if (atualizacoes.data_nascimento) {
      const aniversario = formatarAniversario(atualizacoes.data_nascimento);
      if (!aniversario) return { ok: false, motivo: 'dia/mês de aniversário inválido -- peça de novo, no formato dia e mês.' };
      atualizacoes.data_nascimento = aniversario;
    }

    const { error } = await supabase.from('clientes').update(atualizacoes).eq('id', contexto.cliente.id);
    if (error) return { ok: false, motivo: error.message };
    return { ok: true, atualizado: atualizacoes };
  }

  // Acha a atividade/profissional mais próximos do nome que a IA extraiu
  // da fala do cliente -- exato primeiro, senão substring. Mesma lógica
  // usada tanto pra registrar quanto pra buscar horário.
  function resolverServico({ nome_servico, nome_profissional }, contexto) {
    // nomeServicoBuscado vazio faz `.includes('')` bater com QUALQUER
    // atividade (string vazia é substring de tudo) -- sem essa guarda, um
    // nome_servico ausente/vazio (ex: Groq mandando argumento incompleto)
    // resolvia silenciosamente pro primeiro serviço do catálogo em vez de
    // falhar. Agora só tenta o match se o cliente/IA realmente deu um nome.
    const nomeServicoBuscado = (nome_servico || '').trim().toLowerCase();
    const atividade = !nomeServicoBuscado ? undefined
      : (contexto.atividades || []).find(a => a.nome.toLowerCase() === nomeServicoBuscado)
      || (contexto.atividades || []).find(a => a.nome.toLowerCase().includes(nomeServicoBuscado));

    const nomeProfissionalBuscado = (nome_profissional || '').toLowerCase();
    const profissional = nomeProfissionalBuscado
      ? (contexto.profissionais || []).find(p => p.nome.toLowerCase().includes(nomeProfissionalBuscado))
      : null;

    return { atividade, profissional };
  }

  if (chamada.function?.name === 'registrar_solicitacao_agendamento') {
    if (!argumentos.pedido_cliente) return { ok: false, motivo: 'pedido_cliente é obrigatório' };
    if (!argumentos.servicos?.length) return { ok: false, motivo: 'servicos é obrigatório' };

    const grupoId = randomUUID();
    const agoraBase = Date.now();
    // created_at explícito e escalonado por índice -- um INSERT em lote só
    // (uma linha por serviço) pode gravar todas as linhas com o mesmo
    // valor de now(), já que o Postgres avalia now() uma vez por
    // statement. Sem isso, /grupo/:grupoId/aceitar (que usa
    // order('created_at') pra reconstituir a ordem pedida pelo cliente)
    // teria desempate indefinido.
    const linhas = argumentos.servicos.map((s, i) => {
      const { atividade, profissional } = resolverServico(s, contexto);
      return {
        estabelecimento_id: contexto.estabelecimentoId,
        cliente_id: contexto.cliente.id,
        estabelecimento_atividade_id: atividade?.id || null,
        profissional_id: profissional?.id || null,
        pedido_cliente: argumentos.pedido_cliente,
        data_hora_solicitada: argumentos.data_hora_solicitada || null,
        grupo_id: grupoId,
        created_at: new Date(agoraBase + i).toISOString(),
      };
    });

    const { error } = await supabase.from('solicitacoes_agendamento').insert(linhas);
    if (error) return { ok: false, motivo: error.message };
    return { ok: true, registrado: true, quantidade: linhas.length };
  }

  if (chamada.function?.name === 'buscar_horarios_disponiveis') {
    if (!argumentos.servicos?.length) return { ok: false, motivo: 'servicos é obrigatório' };

    const resolvidos = argumentos.servicos.map(s => ({ ...resolverServico(s, contexto), pedido: s }));
    const naoEncontrados = resolvidos.filter(r => !r.atividade).map(r => r.pedido.nome_servico);
    if (naoEncontrados.length) return { ok: false, motivo: `Serviço(s) não encontrado(s) no catálogo: ${naoEncontrados.join(', ')}` };

    const servicosBusca = resolvidos.map(r => ({
      estabelecimentoAtividadeId: r.atividade.id,
      duracaoMin: r.atividade.duracao_min || 60,
      profissionalPreferidoId: r.profissional?.id || null,
    }));

    let propostas;
    try {
      propostas = await buscarHorariosDisponiveis(supabase, {
        estabelecimentoId: contexto.estabelecimentoId,
        servicos: servicosBusca,
        dataPreferida: argumentos.data_preferida || null,
      });
    } catch (erro) {
      return { ok: false, motivo: 'Falha ao buscar horários: ' + erro.message };
    }

    if (!propostas.length) return { ok: false, motivo: 'sem horário disponível na próxima semana' };

    const plano = propostas[0];
    const grupoId = randomUUID();
    const agoraBase = Date.now();
    const linhas = plano.itens.map((item, i) => ({
      estabelecimento_id: contexto.estabelecimentoId,
      cliente_id: contexto.cliente.id,
      estabelecimento_atividade_id: item.estabelecimento_atividade_id,
      profissional_id: item.profissional_id,
      pedido_cliente: `Busca automática: ${argumentos.servicos.map(s => s.nome_servico).join(', ')}`,
      status: 'horario_proposto',
      data_hora_proposta: item.inicio,
      origem_proposta: 'busca_automatica',
      grupo_id: grupoId,
      created_at: new Date(agoraBase + i).toISOString(),
    }));

    const { error } = await supabase.from('solicitacoes_agendamento').insert(linhas);
    if (error) return { ok: false, motivo: error.message };

    // Manda o horário já formatado no fuso de Brasília pro texto que a IA
    // vai narrar -- mandar só o ISO em UTC faz a IA ler o número da hora
    // direto (ex: ler "12:00:00.000Z" como "12h"), errando o horário real
    // que o cliente vai entender -- achado testando de verdade.
    return {
      ok: true,
      data_visita: plano.data,
      plano: plano.itens.map(item => ({
        servico: contexto.atividades.find(a => a.id === item.estabelecimento_atividade_id)?.nome,
        profissional: contexto.profissionais.find(p => p.id === item.profissional_id)?.nome,
        horario: new Date(item.inicio).toLocaleString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }),
      })),
    };
  }

  if (chamada.function?.name === 'enviar_chave_pix') {
    if (!contexto.chavePix) return { ok: false, motivo: 'estabelecimento não tem chave Pix cadastrada' };
    const copiaCola = gerarCopiaECola({ chavePix: contexto.chavePix, nomeEstabelecimento: contexto.nomeEstabelecimento, cidade: contexto.cidadeEstabelecimento });
    if (!copiaCola) return { ok: false, motivo: 'falha ao gerar o Pix com a chave cadastrada' };
    return { ok: true, copia_cola: copiaCola };
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
function montarSystemPrompt({ estabelecimento, atividades, memoriaCliente, instrucaoExtra, nomeCliente, exigirSinal, chavePix }) {
  const listaAtividades = atividades
    .map(a => `- ${a.nome}${a.preco ? ` (${a.preco_variavel ? 'a partir de ' : ''}R$ ${a.preco})` : ''}${a.duracao_min ? `, ${a.duracao_min}min` : ''}`)
    .join('\n');

  const aberto = estaAberto(estabelecimento);
  const primeiroNome = nomeCliente?.split(' ')[0];

  return `Você é a atendente virtual do ${estabelecimento.nome}, um estabelecimento do segmento "${estabelecimento.segmento_nome}", conversando pelo WhatsApp do negócio. Agora, no horário de Brasília, é hora de dizer "${saudacaoPorHorario()}" -- use essa saudação (ou uma variação natural dela) se for cumprimentar o cliente agora, mas só no início da conversa, não repita em toda mensagem. ${primeiroNome ? `Esse cliente já é cadastrado e se chama ${primeiroNome} -- chame-o pelo primeiro nome ao cumprimentar (ex: "${saudacaoPorHorario()}, ${primeiroNome}!"), nunca pergunte o nome de novo.` : ''}

IMPORTANTE -- AGENDAMENTO (mesma regra com o estabelecimento aberto ou fechado agora -- a busca de horário já considera só os dias/horários de funcionamento certos, então funciona igual nos dois casos): se o assunto for agendamento, primeiro descubra qual(is) serviço(s) exato(s) da lista abaixo o cliente quer (o cliente pode pedir mais de um na mesma visita, ex: unhas, cabelo e depilação -- nesse caso registre todos juntos). Se o cliente disser algo vago tipo só "serviço", "quero agendar" ou "queria marcar um horário", sem dizer qual serviço da lista -- NUNCA chame nenhuma ferramenta ainda, pergunte qual serviço ele quer, oferecendo as opções da lista. Só depois de saber o(s) serviço(s) exato(s), pergunte naturalmente se tem preferência de profissional por serviço ou se tanto faz. Assim que tiver essas informações, chame a ferramenta buscar_horarios_disponiveis -- ela busca de verdade um horário livre, nunca invente horário sozinha. Apresente o que ela devolver de forma natural (nunca peça "responda sim ou não") e pergunte se aquele horário funciona pra ele(a). Se ele topar, o agendamento já fica confirmado na hora -- diga isso com confiança, nunca "a equipe vai confirmar". Se a ferramenta disser que o serviço não foi encontrado no catálogo, NUNCA diga que não tem horário disponível -- isso é um erro de entendimento seu, não falta de vaga; peça desculpa e pergunte de novo qual serviço da lista o cliente quer. Só chame registrar_solicitacao_agendamento (que exige revisão manual da equipe, sem confirmar nada na hora) se buscar_horarios_disponiveis não achar nenhum horário livre na semana pra um serviço que você já identificou corretamente, OU se o cliente insistir num dia/horário específico que já está ocupado e não topar nenhuma das alternativas livres encontradas -- nesse caso diga que a equipe confirma assim que possível, nunca que já está agendado.

${!aberto ? `IMPORTANTE -- FORA DO HORÁRIO DE FUNCIONAMENTO: agora o estabelecimento está fechado (funciona ${estabelecimento.horario_abertura?.slice(0,5)} às ${estabelecimento.horario_fechamento?.slice(0,5)}). Avise isso ao cliente de forma leve, uma vez, sem soar como bloqueio -- e continue o atendimento normalmente, inclusive agendamento (funciona igual, ver regra acima). Não perca o cliente por estar fora do horário.` : ''}

${exigirSinal ? `IMPORTANTE -- CLIENTE COM HISTÓRICO DE FALTAS: esse cliente já faltou em mais de ${LIMITE_FALTAS_SINAL} atendimentos sem avisar. Se o assunto for agendar um novo horário, converse normalmente até fechar os detalhes (serviço, dia/horário, profissional), e só no final, antes de encerrar esse assunto, avise com gentileza (sem soar como punição) que pra confirmar esse agendamento vai ser necessário um sinal antecipado, e que a equipe vai combinar o valor e a forma de pagamento diretamente. Não invente valor nem forma de pagamento do sinal.` : ''}

REGRAS DE TOM (sempre):
- Português do Brasil, cordial e caloroso, mas objetivo — nada de resposta robótica nem parágrafo longo. Pode usar "oi", "tudo bem?" naturalmente, mas sem gíria regional pesada (nunca "oxe", "bah", "mano", "cê").
- No máximo 1 emoji por mensagem, só quando fizer sentido — nunca em toda frase.
- Mensagens curtas, como uma pessoa digitaria no WhatsApp. Se a resposta tiver mais de uma ideia, separe cada ideia num parágrafo próprio (linha em branco entre elas) -- cada parágrafo vira uma mensagem separada de verdade, então não quebre uma frase no meio.
- Você é a atendente automatizada do negócio -- não é preciso anunciar isso a cada mensagem, mas nunca negue ou esconda se o cliente perguntar direta ou indiretamente.
- Nunca invente preço, horário ou serviço fora da lista abaixo.
- Se não tiver certeza de algo, diga com honestidade que vai confirmar com a equipe -- nunca invente pra parecer seguro.
- Se não entender a mensagem, peça esclarecimento com gentileza (ex: "só pra eu entender direitinho, você quer dizer...?"), nunca de forma seca.
- Se o cliente pedir pra parar de receber mensagens ou demonstrar desinteresse, respeite na hora, sem insistir nem repetir a pergunta.
- Se o cliente pedir pra corrigir nome, endereço ou aniversário, use a ferramenta atualizar_cadastro_cliente disponível -- nunca diga que corrigiu ou salvou algo sem realmente chamar a ferramenta.
- Se o cliente perguntar sobre pagar adiantado/antecipado (pra não perder tempo esperando se o salão estiver cheio, por exemplo): receba a ideia bem. ${chavePix ? 'Chame a ferramenta enviar_chave_pix pra mandar a chave/QR de verdade -- nunca digite a chave você mesma, sempre use a ferramenta. O valor continua sendo combinado com a equipe (nunca invente valor).' : 'Nunca invente chave Pix, link de pagamento ou qualquer forma de cobrar -- isso ainda não existe no sistema. Diga com honestidade que a equipe entra em contato pra combinar isso diretamente.'}

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

    const { data: profissionais } = await supabase
      .from('profissionais')
      .select('id, nome')
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
      await enviarRespostaIA({ telefone, texto: respostaTexto, estabelecimentoId });
      return res.sendStatus(200);
    }

    // ── 1.5 RESPOSTA A UMA PROPOSTA DE HORÁRIO PENDENTE ──
    // Se a equipe (ou a busca automática) propôs horário(s) e está
    // esperando resposta, essa mensagem é tratada como resposta a essa
    // proposta (em linguagem natural, nunca exigindo "sim"/"não"
    // literal), não como assunto novo. Um pedido pode ter mais de um
    // serviço (ver migração 24/grupo_id) -- busca a proposta mais
    // recente e todas as irmãs do mesmo grupo (grupo_id null = pedido
    // avulso de um serviço só, grupo de 1).
    const { data: propostaMaisRecente } = await supabase
      .from('solicitacoes_agendamento')
      .select('id, grupo_id')
      .eq('cliente_id', cliente.id)
      .eq('status', 'horario_proposto')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let solicitacoesPendentes = [];
    if (propostaMaisRecente) {
      let consultaGrupo = supabase
        .from('solicitacoes_agendamento')
        .select('*, estabelecimento_atividades(nome, duracao_min)')
        .eq('cliente_id', cliente.id)
        .eq('status', 'horario_proposto');
      consultaGrupo = propostaMaisRecente.grupo_id
        ? consultaGrupo.eq('grupo_id', propostaMaisRecente.grupo_id)
        : consultaGrupo.eq('id', propostaMaisRecente.id);
      const { data } = await consultaGrupo;
      solicitacoesPendentes = data || [];
    }

    if (solicitacoesPendentes.length) {
      const respostaTexto = await tratarRespostaPropostaHorario({ solicitacoesPendentes, mensagem, cliente, estabelecimento, estabelecimentoId });
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

    // Cliente com histórico de faltar sem avisar -- passa a exigir sinal
    // antecipado pra confirmar o próximo agendamento (não é cobrança
    // automática, só um requisito que a IA comunica; quem efetivamente
    // combina o sinal com a cliente é a equipe, ver LIMITE_FALTAS_SINAL).
    const { count: faltasCount } = await supabase
      .from('agendamentos')
      .select('id', { count: 'exact', head: true })
      .eq('cliente_id', cliente.id)
      .eq('status', 'nao_compareceu');

    const systemPrompt = montarSystemPrompt({
      estabelecimento: { ...estabelecimento, segmento_nome: estabelecimento.segmentos.nome },
      atividades: atividades || [],
      memoriaCliente,
      instrucaoExtra,
      nomeCliente: cliente.nome,
      exigirSinal: (faltasCount || 0) > LIMITE_FALTAS_SINAL,
      chavePix: estabelecimento.chave_pix,
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
        const resultado = await executarFerramentaIA(chamada, { cliente, atividades: atividades || [], profissionais: profissionais || [], estabelecimentoId, chavePix: estabelecimento.chave_pix, nomeEstabelecimento: estabelecimento.nome, cidadeEstabelecimento: estabelecimento.cidade });
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

// Regras de tom compartilhadas entre a conversa livre (montarSystemPrompt)
// e o onboarding determinístico abaixo -- mesma persona o tempo todo, só
// muda a instrução específica de cada etapa.
const REGRAS_DE_TOM = `Português do Brasil, cordial e caloroso, mas objetivo -- nada de resposta robótica nem parágrafo longo. Pode usar "oi", "tudo bem?" naturalmente, mas sem gíria regional pesada (nunca "oxe", "bah", "mano", "cê"). No máximo 1 emoji por mensagem, só quando fizer sentido. Mensagens curtas, como uma pessoa digitaria no WhatsApp -- se tiver mais de uma ideia, separe cada uma num parágrafo próprio (linha em branco entre elas). Nunca invente nada que não foi informado.`;

// Gera o texto de cada etapa do onboarding via IA (varia a cada
// conversa, soa como gente conversando de verdade) em vez de um texto
// fixo repetido sempre igual pra todo cliente -- só a instrução do que
// perguntar/confirmar é fixa, o texto em si nunca é. Cai pro texto fixo
// só se a chamada à IA falhar (mesmo padrão de robustez de
// extrairCampoComIA), pra nunca deixar o cliente sem resposta.
async function gerarMensagemOnboarding(instrucao, mensagemCliente, textoFixo) {
  try {
    const resposta = await groq.chat.completions.create({
      model: MODELO_IA,
      messages: [
        { role: 'system', content: `Você é a atendente virtual de um salão de beleza, conversando pelo WhatsApp.\n\nREGRAS DE TOM: ${REGRAS_DE_TOM}\n\nSUA TAREFA AGORA: ${instrucao}` },
        { role: 'user', content: mensagemCliente || '(início da conversa, cliente ainda não disse nada)' },
      ],
      temperature: 0.7,
      max_tokens: 200,
    });
    return resposta.choices[0].message.content.trim() || textoFixo;
  } catch (erro) {
    console.error('Falha ao gerar mensagem de onboarding via IA, usando texto fixo:', erro.message);
    return textoFixo;
  }
}

// ============================================================
// ONBOARDING — nome, endereço, (aniversário opcional)
// Telefone já é conhecido automaticamente pelo número do WhatsApp. A
// ORDEM/estado é determinística (sempre nome -> endereço -> completo),
// só o TEXTO de cada etapa é gerado pela IA (ver gerarMensagemOnboarding).
// ============================================================
async function processarOnboarding({ cliente, mensagem, estabelecimento }) {
  switch (cliente.estado_onboarding) {
    case 'novo': {
      await supabase.from('clientes').update({ estado_onboarding: 'aguardando_nome' }).eq('id', cliente.id);
      const instrucao = `Cumprimente o cliente pela primeira vez usando "${saudacaoPorHorario()}" (ou uma variação natural dela), dê as boas-vindas ao ${estabelecimento.nome}, e peça o nome completo dele(a) pra começar o cadastro. Não peça mais nada além do nome nessa mensagem.`;
      return gerarMensagemOnboarding(instrucao, mensagem, `${saudacaoPorHorario()}! Seja bem-vindo(a) ao ${estabelecimento.nome} 😊\n\nPra começar, qual é o seu nome completo?`);
    }

    case 'aguardando_nome': {
      const nome = await extrairCampoComIA(mensagem, 'nome completo da pessoa');
      await supabase.from('clientes').update({ nome, estado_onboarding: 'aguardando_endereco' }).eq('id', cliente.id);
      const primeiroNome = nome.split(' ')[0];
      const instrucao = `O cliente acabou de informar o nome (${primeiroNome}). Reaja de forma breve e simpática ao nome, e peça o endereço completo dele(a) (rua, número e bairro), explicando rapidamente que é só pra ocasiões especiais, tipo mandar uma lembrancinha no aniversário. Não peça mais nada além do endereço nessa mensagem.`;
      return gerarMensagemOnboarding(instrucao, mensagem, `Prazer, ${primeiroNome}! 😊\n\nAgora me conta seu endereço completo (rua, número e bairro)? A gente usa isso só pra ocasiões especiais, tipo mandar uma lembrancinha no seu aniversário.`);
    }

    case 'aguardando_endereco': {
      const endereco = await extrairCampoComIA(mensagem, 'endereço completo (rua, número e bairro -- mantenha tudo que a pessoa informou, não corte nenhuma parte)');
      await supabase.from('clientes').update({ endereco, estado_onboarding: 'completo' }).eq('id', cliente.id);
      const instrucao = `O cliente acabou de informar o endereço -- confirme de forma breve que o cadastro está completo. Convide (sem pressionar, é opcional) a contar o dia do aniversário dele(a) depois -- só dia e mês, sem precisar do ano -- pra não esquecerem dessa data. Por fim, pergunte como pode ajudar hoje.`;
      return gerarMensagemOnboarding(instrucao, mensagem, `Perfeito, já está tudo registrado! ✅\n\nSe quiser, depois me conta o dia do seu aniversário também (só dia e mês, sem precisar do ano), assim a gente não esquece de você nessa data.\n\nAgora me conta, como posso te ajudar hoje?`);
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
      description: 'Registra quais dos horários propostos o cliente aceitou, com base na resposta em linguagem natural dele.',
      parameters: {
        type: 'object',
        properties: {
          resposta: { type: 'string', enum: ['todos', 'parcial', 'nenhum'], description: '"todos" se o cliente aceitou tudo o que foi proposto, "nenhum" se recusou tudo, "parcial" se aceitou só parte dos serviços propostos.' },
          servicos_aceitos: { type: 'array', items: { type: 'string' }, description: 'Nomes dos serviços que o cliente aceitou -- só preencha quando resposta="parcial".' },
          novo_pedido: { type: 'string', description: 'Se recusou algo e sugeriu outra preferência de dia/horário, registre aqui. Deixe vazio se não sugeriu nada.' },
        },
        required: ['resposta'],
      },
    },
  },
];

// Um pedido pode ter mais de um serviço (ver migração 24/grupo_id) --
// solicitacoesPendentes é sempre um array (grupo de 1 pros pedidos
// antigos/avulsos de um serviço só, continua funcionando igual).
async function tratarRespostaPropostaHorario({ solicitacoesPendentes, mensagem, cliente, estabelecimento, estabelecimentoId }) {
  const nomeServico = s => s.estabelecimento_atividades?.nome || 'atendimento';
  const listaServicos = solicitacoesPendentes.map(nomeServico).join(', ');
  const dataFormatada = new Date(solicitacoesPendentes[0].data_hora_proposta).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  const primeiroNome = cliente.nome?.split(' ')[0] || '';

  // A Groq com tool_choice:'required' já se mostrou instável em teste real
  // (às vezes gera JSON malformado, às vezes não chama a ferramenta) -- se
  // isso falhar, NUNCA travamos o cliente sem resposta nem assumimos nada:
  // respondemos com honestidade que a equipe vai confirmar, e deixamos as
  // solicitações como estão (horario_proposto) pra alguém revisar manualmente.
  let resultado = null;
  for (let tentativa = 0; tentativa < 2 && !resultado; tentativa++) {
    try {
      const resposta = await groq.chat.completions.create({
        model: MODELO_IA,
        messages: [
          { role: 'system', content: `Você está avaliando a resposta de um cliente a uma proposta de horário pro(s) serviço(s) ${listaServicos}, começando ${dataFormatada}. Use a ferramenta responder_proposta_horario pra registrar se ele aceitou tudo, nada, ou só parte, com base na mensagem dele -- que pode vir em qualquer forma natural (nunca exija "sim"/"não" literal).` },
          { role: 'user', content: mensagem },
        ],
        tools: FERRAMENTA_RESPOSTA_PROPOSTA,
        tool_choice: 'required',
        temperature: 0.2,
        max_tokens: 200,
      });
      const chamada = resposta.choices[0].message.tool_calls?.[0];
      const argumentos = JSON.parse(chamada.function.arguments);
      if (!['todos', 'parcial', 'nenhum'].includes(argumentos.resposta)) throw new Error('resposta fora do esperado');
      // Filtra nome vazio/só espaço antes de guardar -- um item vazio em
      // servicos_aceitos casaria com QUALQUER solicitação pendente lá na
      // frente (string vazia é substring de tudo), virando "aceitou tudo"
      // por engano quando o cliente só aceitou parte.
      const servicosAceitosLimpos = (argumentos.servicos_aceitos || []).map(n => (n || '').trim()).filter(Boolean);
      resultado = { resposta: argumentos.resposta, servicosAceitos: servicosAceitosLimpos, novoPedido: argumentos.novo_pedido || '' };
    } catch (erro) {
      console.error(`Falha ao interpretar resposta de proposta de horário (tentativa ${tentativa + 1}):`, erro.message);
    }
  }

  // "parcial" sem nenhum serviço listado é a Groq não tendo certeza de
  // qual parte foi aceita -- mesmo tratamento de quando a ferramenta falha
  // de vez: nunca assume "recusou tudo" por ambiguidade, principalmente
  // porque pra item de busca_automatica isso marcaria como recusado
  // (terminal) sem o cliente ter realmente dito não a nada.
  if (!resultado || (resultado.resposta === 'parcial' && !resultado.servicosAceitos.length)) {
    return `Entendi${primeiroNome ? ', ' + primeiroNome : ''}! Vou confirmar isso com a equipe e já te retorno por aqui.`;
  }

  const aceitas = resultado.resposta === 'todos' ? solicitacoesPendentes
    : resultado.resposta === 'nenhum' ? []
    : solicitacoesPendentes.filter(s => resultado.servicosAceitos.some(nome => nomeServico(s).toLowerCase().includes(nome.toLowerCase())));
  const recusadas = solicitacoesPendentes.filter(s => !aceitas.includes(s));

  const confirmadas = [];
  const emConflito = [];

  for (const s of aceitas) {
    // Confirma direto sempre que aceito, seja a proposta da equipe (ela já
    // vetou esse horário manualmente ao propor) ou de busca automática --
    // o horário buscado já respeita os dias/horários de funcionamento do
    // estabelecimento (ver buscarHorariosDisponiveis), então não precisa
    // do salão estar aberto agora nesse instante pra confirmar; e
    // confirmarSolicitacaoAgendamento recheca conflito de verdade antes de
    // criar, então não tem risco de dois agendamentos no mesmo horário.
    const resultadoConfirmacao = await confirmarSolicitacaoAgendamento(supabase, { solicitacaoId: s.id });
    if (resultadoConfirmacao.ok) {
      confirmadas.push(s);
    } else {
      // Alguém ocupou esse horário nesse meio-tempo -- volta pra fila da
      // equipe revisar (status 'pendente'), já que prometemos pro cliente
      // que "a equipe vai te chamar com uma nova opção" logo abaixo.
      await supabase.from('solicitacoes_agendamento').update({ status: 'pendente' }).eq('id', s.id);
      emConflito.push(s);
    }
  }

  for (const s of recusadas) {
    if (s.origem_proposta === 'busca_automatica') {
      await supabase.from('solicitacoes_agendamento').update({ status: 'recusado' }).eq('id', s.id);
    } else {
      const pedidoAtualizado = resultado.novoPedido
        ? `${s.pedido_cliente} / cliente recusou o horário proposto e sugeriu: ${resultado.novoPedido}`
        : `${s.pedido_cliente} / cliente recusou o horário proposto (${dataFormatada})`;
      await supabase.from('solicitacoes_agendamento').update({ status: 'pendente', pedido_cliente: pedidoAtualizado, data_hora_proposta: null }).eq('id', s.id);
    }
  }

  const partes = [];
  if (confirmadas.length) {
    // Serviços em sequência têm horários diferentes entre si (ver
    // buscarHorariosDisponiveis) -- lista cada um com o próprio horário
    // em vez de repetir um só horário pra todos, que ficaria errado.
    const detalhes = confirmadas.map(s => `${nomeServico(s)} (${new Date(s.data_hora_proposta).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })})`).join(', ');
    partes.push(`${primeiroNome ? primeiroNome + ', que' : 'Que'} bom! ${detalhes} ${confirmadas.length > 1 ? 'ficaram confirmados' : 'ficou confirmado'} 😊`);
  }
  if (emConflito.length) {
    partes.push(`${emConflito.map(nomeServico).join(', ')} infelizmente esse horário acabou de ser ocupado aqui do nosso lado. Vou pedir pra equipe te chamar com uma nova opção.`);
  }
  if (recusadas.length && !confirmadas.length && !emConflito.length) {
    partes.push(`Entendi${primeiroNome ? ', ' + primeiroNome : ''}! Vou ver outro horário que funcione melhor pra você. Assim que tiver uma opção, te aviso por aqui.`);
  }

  return partes.join('\n\n') || `Entendi${primeiroNome ? ', ' + primeiroNome : ''}!`;
}

// Mensagem enviada quando a equipe propõe um horário alternativo pelo
// painel -- gerada pela IA (mesmo tom do resto do atendimento), não é
// um template fixo tipo "responda sim ou não".
// IMPORTANTE: essa mensagem é uma PERGUNTA, o agendamento ainda NÃO foi
// criado (só é criado de verdade se o cliente responder que aceita, ver
// tratarRespostaPropostaHorario) -- achado testando de verdade: sem uma
// instrução negativa explícita proibindo tom de confirmação, a IA às
// vezes escrevia como se já estivesse tudo certo, confundindo o cliente.
async function gerarMensagemPropostaHorario({ nomeCliente, nomeServico, dataHoraProposta, dataHoraSolicitada, pedidoCliente }) {
  const dataFormatada = new Date(dataHoraProposta).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  const primeiroNome = nomeCliente?.split(' ')[0] || '';
  // Nem sempre dá pra saber um horário exato que o cliente pediu (ele pode
  // ter só dito "sábado de manhã", sem hora certa) -- nesse caso usa o
  // texto livre do pedido em vez de tentar formatar uma data que não existe.
  const pedidoOriginal = dataHoraSolicitada
    ? new Date(dataHoraSolicitada).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
    : pedidoCliente || null;
  const textoFixo = `Desculpa${primeiroNome ? ', ' + primeiroNome : ''}! ${pedidoOriginal ? `O horário que você pediu (${pedidoOriginal})` : 'O horário que você pediu'} pra ${nomeServico || 'o atendimento'} infelizmente está ocupado, mas temos ${dataFormatada} disponível. Pode ser?`;

  try {
    const resposta = await groq.chat.completions.create({
      model: MODELO_IA,
      messages: [
        { role: 'system', content: 'Você é a atendente virtual de um salão, escrevendo pelo WhatsApp. Tom cordial e caloroso, mensagem curta (2-3 frases), no máximo 1 emoji. Essa mensagem é uma PERGUNTA -- o cliente ainda não respondeu nada e o agendamento ainda não existe. Comece pedindo desculpa, diga que o horário pedido está ocupado, proponha a alternativa, e pergunte se funciona (nunca "responda sim ou não", pergunte como uma pessoa perguntaria). NUNCA diga que já está confirmado, agendado, marcado ou "tudo certo" -- isso só acontece depois que o cliente responder que aceita.' },
        { role: 'user', content: `Escreva a mensagem${primeiroNome ? ' pra ' + primeiroNome : ''} pedindo desculpa porque ${pedidoOriginal ? `o horário que pediu (${pedidoOriginal})` : 'o horário que pediu'} pra "${nomeServico || 'o atendimento'}" está ocupado, propondo ${dataFormatada} como alternativa, e perguntando se pode ser.` },
      ],
      temperature: 0.5,
      max_tokens: 150,
    });
    return resposta.choices[0].message.content;
  } catch (erro) {
    console.error('Falha ao gerar mensagem de proposta de horário, usando texto padrão:', erro.message);
    return textoFixo;
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

  // Uma linha por interação (não por campo) -- a IA lê/eventualmente
  // escreve dado de cliente (nome, telefone, endereço) a cada mensagem;
  // logar campo a campo seria ruído demais no log de auditoria.
  registrarAcessoAuditoria(supabase, {
    estabelecimentoId,
    ator: 'sistema:whatsapp',
    operacao: 'write',
    tabela: 'clientes',
    registroId: clienteId,
    detalhe: 'Leitura/atualização de dado de cliente durante conversa automatizada do WhatsApp',
  });
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
module.exports.tratarRespostaPropostaHorario = tratarRespostaPropostaHorario;
