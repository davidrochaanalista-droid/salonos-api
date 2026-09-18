/**
 * SalonOS API — Solicitações de agendamento fora do horário
 * =============================================================
 * Quando o cliente pede horário com o salão fechado, a IA do WhatsApp
 * registra aqui (ver ferramenta registrar_solicitacao_agendamento em
 * routes/whatsapp.js) em vez de só conversar sobre isso. A dona/
 * funcionária vê na Agenda e decide: aceitar como pedido, ou propor
 * outro horário -- a resposta do cliente à proposta é tratada pela IA
 * no webhook, sempre em linguagem natural (nunca "responda sim ou não").
 */

const express = require('express');
const { enviarMensagemWhatsApp, gerarMensagemPropostaHorario } = require('./whatsapp');
const { buscarConflitoAgendamento, estaNoPassado } = require('../lib/disponibilidade');
const { confirmarSolicitacaoAgendamento } = require('../lib/agendamento-confirmacao');
const router = express.Router();

// Mapeia o motivo devolvido por confirmarSolicitacaoAgendamento pro status
// HTTP certo -- a função em si é usada tanto aqui (HTTP) quanto no webhook
// do WhatsApp (que não usa status HTTP, só decide o texto da resposta).
function statusPorMotivo(resultado) {
  if (resultado.motivo === 'Solicitação não encontrada.') return 404;
  if (resultado.conflito) return 409;
  return 400;
}

async function notificarConfirmacao(solicitacao) {
  const dataFormatada = new Date(solicitacao.data_hora_proposta || solicitacao.data_hora_solicitada).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  const primeiroNome = solicitacao.clientes?.nome?.split(' ')[0] || '';
  const texto = `${primeiroNome ? primeiroNome + ', tudo' : 'Tudo'} certo! Seu horário pra ${solicitacao.estabelecimento_atividades?.nome || 'o atendimento'} ficou confirmado pra ${dataFormatada}. Te esperamos por aqui 😊`;
  return enviarMensagemWhatsApp({ telefone: solicitacao.clientes?.telefone, texto, estabelecimentoId: solicitacao.estabelecimento_id }).catch(erro =>
    console.error('Falha ao confirmar agendamento por WhatsApp:', erro.message)
  );
}

// Aceite em lote confirma vários serviços do mesmo pedido de uma vez --
// uma mensagem por serviço seria ruído (3 "Tudo certo!" seguidos pro
// mesmo cliente); consolida numa única mensagem, mesmo espírito de
// tratarRespostaPropostaHorario em whatsapp.js.
async function notificarConfirmacaoGrupo(solicitacoesConfirmadas) {
  if (!solicitacoesConfirmadas.length) return;
  const primeira = solicitacoesConfirmadas[0];
  const primeiroNome = primeira.clientes?.nome?.split(' ')[0] || '';
  const detalhes = solicitacoesConfirmadas.map((s) => {
    const dataFormatada = new Date(s.data_hora_proposta || s.data_hora_solicitada).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    return `${s.estabelecimento_atividades?.nome || 'atendimento'} (${dataFormatada})`;
  }).join(', ');
  const texto = `${primeiroNome ? primeiroNome + ', tudo' : 'Tudo'} certo! ${detalhes} ${solicitacoesConfirmadas.length > 1 ? 'ficaram confirmados' : 'ficou confirmado'}. Te esperamos por aqui 😊`;
  return enviarMensagemWhatsApp({ telefone: primeira.clientes?.telefone, texto, estabelecimentoId: primeira.estabelecimento_id }).catch(erro =>
    console.error('Falha ao confirmar agendamento por WhatsApp:', erro.message)
  );
}

// GET /estabelecimentos/:id/solicitacoes-agendamento?status=pendente
router.get('/estabelecimentos/:id/solicitacoes-agendamento', async (req, res) => {
  let consulta = req.supabase
    .from('solicitacoes_agendamento')
    .select('*, clientes(nome, telefone), estabelecimento_atividades(nome, duracao_min), profissionais(nome)')
    .eq('estabelecimento_id', req.params.id)
    .order('created_at', { ascending: false });

  if (req.query.status) consulta = consulta.eq('status', req.query.status);

  const { data, error } = await consulta;
  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// POST /solicitacoes-agendamento/:id/aceitar — cria o agendamento de
// verdade com o horário que o cliente pediu (ou o horário proposto,
// se já tiver um), e confirma por WhatsApp.
router.post('/solicitacoes-agendamento/:id/aceitar', async (req, res) => {
  const resultado = await confirmarSolicitacaoAgendamento(req.supabase, { solicitacaoId: req.params.id });
  if (!resultado.ok) return res.status(statusPorMotivo(resultado)).json({ erro: resultado.motivo });

  res.json(resultado.agendamento);
  notificarConfirmacao(resultado.solicitacao);
});

// POST /solicitacoes-agendamento/grupo/:grupoId/aceitar — aceita de uma
// vez todas as solicitações de um mesmo pedido do cliente (ex: unhas +
// cabelo + depilação pedidos juntos, ver migração 24/grupo_id). Aceita
// o que der pra aceitar e reporta o resto -- não é tudo-ou-nada, porque
// um serviço do grupo pode ter conflito enquanto os outros não.
router.post('/solicitacoes-agendamento/grupo/:grupoId/aceitar', async (req, res) => {
  const { data: solicitacoes, error } = await req.supabase
    .from('solicitacoes_agendamento')
    .select('id, data_hora_solicitada, data_hora_proposta, estabelecimento_atividades(duracao_min)')
    .eq('grupo_id', req.params.grupoId)
    .in('status', ['pendente', 'horario_proposto'])
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ erro: error.message });
  if (!solicitacoes?.length) return res.status(404).json({ erro: 'Nenhuma solicitação pendente encontrada nesse grupo.' });

  // Um pedido "fora do horário" com vários serviços chega com o MESMO
  // horário pedido em cada linha (o cliente só disse "sábado às 10h" uma
  // vez pro grupo inteiro) -- aceitar tudo de uma vez precisa encadear em
  // sequência (serviço 2 começa quando o 1 termina), senão os agendamentos
  // nascem todos sobrepostos no mesmo instante. Mesma regra de "mesma
  // visita, em sequência" já usada em buscarHorariosDisponiveis.
  let cursor = null;
  let horarioBaseMs = null;
  for (const s of solicitacoes) {
    const horarioAtual = s.data_hora_proposta || s.data_hora_solicitada;
    if (!horarioAtual) continue;
    const horarioAtualMs = new Date(horarioAtual).getTime();

    if (horarioBaseMs === null) {
      horarioBaseMs = horarioAtualMs;
      cursor = horarioAtualMs;
    } else if (horarioAtualMs === horarioBaseMs) {
      // Mesmo horário pedido/proposto pro grupo inteiro (ex: cliente só
      // disse "sábado às 10h" uma vez) -- empilha a partir do cursor.
      const { error: errEncadear } = await req.supabase
        .from('solicitacoes_agendamento')
        .update({ data_hora_proposta: new Date(cursor).toISOString() })
        .eq('id', s.id);
      // Se a escrita falhar, não segue com o valor em memória -- a próxima
      // confirmação faria um SELECT novo, releria o horário antigo/errado
      // do banco e criaria um agendamento sobreposto ao serviço anterior,
      // sem erro nenhum reportado.
      if (errEncadear) return res.status(500).json({ erro: `Falha ao encadear horário do serviço: ${errEncadear.message}` });
      s.data_hora_proposta = new Date(cursor).toISOString();
    } else {
      // Já tem um horário diferente e deliberado (ex: proposto
      // individualmente pra esse item) -- não mexe, só segue o cursor
      // a partir dele pros próximos itens que ainda compartilham a base.
      cursor = horarioAtualMs;
    }
    cursor += (s.estabelecimento_atividades?.duracao_min || 60) * 60000;
  }

  const resultados = [];
  const confirmadas = [];
  for (const s of solicitacoes) {
    const resultado = await confirmarSolicitacaoAgendamento(req.supabase, { solicitacaoId: s.id });
    resultados.push({ solicitacao_id: s.id, ...resultado });
    if (resultado.ok) confirmadas.push(resultado.solicitacao);
  }
  notificarConfirmacaoGrupo(confirmadas);
  res.json(resultados);
});

// POST /solicitacoes-agendamento/:id/propor-horario
// Body: { data_hora_proposta } — manda WhatsApp com o novo horário
// sugerido, em linguagem natural, e fica aguardando a resposta do
// cliente (tratada pela IA no webhook, ver aguardandoRespostaProposta).
router.post('/solicitacoes-agendamento/:id/propor-horario', async (req, res) => {
  const { data_hora_proposta, profissional_id } = req.body;
  if (!data_hora_proposta) return res.status(400).json({ erro: 'data_hora_proposta é obrigatório.' });
  if (estaNoPassado(data_hora_proposta)) {
    return res.status(400).json({ erro: 'Não é possível propor uma data/hora que já passou.' });
  }

  const { data: solicitacao, error: errBusca } = await req.supabase
    .from('solicitacoes_agendamento')
    .select('*, clientes(nome, telefone), estabelecimento_atividades(nome, duracao_min)')
    .eq('id', req.params.id)
    .single();
  if (errBusca || !solicitacao) return res.status(404).json({ erro: 'Solicitação não encontrada.' });
  if (solicitacao.status === 'confirmado') return res.status(400).json({ erro: 'Essa solicitação já foi confirmada.' });

  const profissionalEscolhido = profissional_id || solicitacao.profissional_id;
  if (profissionalEscolhido) {
    const duracaoMin = solicitacao.estabelecimento_atividades?.duracao_min || 60;
    const inicio = new Date(data_hora_proposta);
    const fim = new Date(inicio.getTime() + duracaoMin * 60000);
    const conflito = await buscarConflitoAgendamento(req.supabase, { profissionalId: profissionalEscolhido, inicio: inicio.toISOString(), fim: fim.toISOString() });
    if (conflito) {
      return res.status(409).json({ erro: `Esse profissional já tem um atendimento nesse horário (com ${conflito.clientes?.nome || 'outra cliente'}). Escolha outro horário ou profissional.` });
    }
  }

  // origem_proposta vira/permanece 'equipe' -- esse horário foi vetado por
  // uma pessoa agora, então se o cliente recusar/aceitar depois com o
  // salão fechado, tratarRespostaPropostaHorario (whatsapp.js) precisa
  // tratar como já revisado por humano, não mais como busca automática
  // sem revisão.
  const { error: errUpdate } = await req.supabase
    .from('solicitacoes_agendamento')
    .update({ status: 'horario_proposto', data_hora_proposta, profissional_id: profissionalEscolhido || null, origem_proposta: 'equipe' })
    .eq('id', req.params.id);
  if (errUpdate) return res.status(500).json({ erro: errUpdate.message });

  res.sendStatus(204);

  gerarMensagemPropostaHorario({
    nomeCliente: solicitacao.clientes?.nome,
    nomeServico: solicitacao.estabelecimento_atividades?.nome,
    dataHoraProposta: data_hora_proposta,
    dataHoraSolicitada: solicitacao.data_hora_solicitada,
    pedidoCliente: solicitacao.pedido_cliente,
  }).then(texto =>
    enviarMensagemWhatsApp({ telefone: solicitacao.clientes?.telefone, texto, estabelecimentoId: solicitacao.estabelecimento_id })
  ).catch(erro => console.error('Falha ao propor horário por WhatsApp:', erro.message));
});

module.exports = router;
