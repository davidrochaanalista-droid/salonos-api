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

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODELO_IA = 'llama-3.3-70b-versatile';

// Gap de tempo que caracteriza "nova conversa" (não continuação imediata)
// para disparar a pergunta de repetição de procedimento. Ajustável.
const SESSAO_GAP_HORAS = 4;

// ============================================================
// SYSTEM PROMPT
// ============================================================
function montarSystemPrompt({ estabelecimento, atividades, memoriaCliente, instrucaoExtra }) {
  const listaAtividades = atividades
    .map(a => `- ${a.nome}${a.preco ? ` (a partir de R$ ${a.preco})` : ''}${a.duracao_min ? `, ${a.duracao_min}min` : ''}`)
    .join('\n');

  return `Você é a assistente virtual do ${estabelecimento.nome}, um estabelecimento do segmento "${estabelecimento.segmento_nome}".

REGRAS DE TOM (sempre):
- Português do Brasil, formal-cordial, sem gírias e sem regionalismo (nunca "oxe", "bah", "mano", "cê").
- Clara, direta e simpática — recepcionista experiente, não robô.
- Nunca invente preço, horário ou serviço fora da lista abaixo.
- Se não tiver certeza, diga que vai confirmar com a equipe.

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
    const { telefone, mensagem } = extrairMensagem(req.body);

    const { data: estabelecimento } = await supabase
      .from('estabelecimentos')
      .select('*, segmentos(nome)')
      .eq('id', estabelecimentoId)
      .single();

    const { data: atividades } = await supabase
      .from('estabelecimento_atividades')
      .select('id, nome, preco, duracao_min')
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
    });

    const resposta = await groq.chat.completions.create({
      model: MODELO_IA,
      messages: [{ role: 'system', content: systemPrompt }, ...historico, { role: 'user', content: mensagem }],
      temperature: 0.6,
      max_tokens: 400,
    });

    const respostaTexto = resposta.choices[0].message.content;
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
    await enviarMensagemWhatsApp({ telefone, texto: respostaTexto, estabelecimentoId });

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
      return `Oi! Seja bem-vindo ao ${estabelecimento.nome} 😊 Para começar, qual é o seu nome completo?`;
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
// AUXILIARES
// ============================================================
async function registrarMensagens({ estabelecimentoId, clienteId, mensagem, respostaTexto }) {
  await supabase.from('whatsapp_mensagens').insert([
    { estabelecimento_id: estabelecimentoId, cliente_id: clienteId, direcao: 'recebida', conteudo: mensagem },
    { estabelecimento_id: estabelecimentoId, cliente_id: clienteId, direcao: 'enviada', conteudo: respostaTexto, modelo_ia: MODELO_IA },
  ]);
}

function extrairMensagem(body) {
  // Adaptar ao payload real do provedor escolhido (Evolution API ou Cloud API).
  return { telefone: body.from, mensagem: body.text };
}

async function enviarMensagemWhatsApp({ telefone, texto, estabelecimentoId }) {
  // Implementar conforme o provedor escolhido (ver README-fase1.md, seção 3).
}

module.exports = router;
