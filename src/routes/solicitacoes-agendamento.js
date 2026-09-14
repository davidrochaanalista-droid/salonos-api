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
const router = express.Router();

// GET /estabelecimentos/:id/solicitacoes-agendamento?status=pendente
router.get('/estabelecimentos/:id/solicitacoes-agendamento', async (req, res) => {
  let consulta = req.supabase
    .from('solicitacoes_agendamento')
    .select('*, clientes(nome, telefone), estabelecimento_atividades(nome, duracao_min)')
    .eq('estabelecimento_id', req.params.id)
    .order('created_at', { ascending: false });

  if (req.query.status) consulta = consulta.eq('status', req.query.status);

  const { data, error } = await consulta;
  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// POST /solicitacoes-agendamento/:id/aceitar — cria o agendamento de
// verdade com o horário que o cliente pediu, e confirma por WhatsApp.
router.post('/solicitacoes-agendamento/:id/aceitar', async (req, res) => {
  const { data: solicitacao, error: errBusca } = await req.supabase
    .from('solicitacoes_agendamento')
    .select('*, clientes(nome, telefone), estabelecimento_atividades(nome, duracao_min)')
    .eq('id', req.params.id)
    .single();
  if (errBusca || !solicitacao) return res.status(404).json({ erro: 'Solicitação não encontrada.' });
  if (solicitacao.status !== 'pendente' && solicitacao.status !== 'horario_proposto') {
    return res.status(400).json({ erro: 'Essa solicitação já foi respondida.' });
  }
  if (!solicitacao.data_hora_solicitada) {
    return res.status(400).json({ erro: 'Essa solicitação não tem um horário claro pra aceitar direto -- use "propor outro horário" pra sugerir um horário certo.' });
  }

  const duracaoMin = solicitacao.estabelecimento_atividades?.duracao_min || 60;
  const inicio = new Date(solicitacao.data_hora_solicitada);
  const fim = new Date(inicio.getTime() + duracaoMin * 60000);

  const { data: agendamento, error: errAgendamento } = await req.supabase
    .from('agendamentos')
    .insert({
      estabelecimento_id: req.params.id,
      cliente_id: solicitacao.cliente_id,
      estabelecimento_atividade_id: solicitacao.estabelecimento_atividade_id,
      inicio: inicio.toISOString(),
      fim: fim.toISOString(),
      origem: 'whatsapp',
      observacao: 'Solicitado fora do horário de funcionamento, aceito pela equipe.',
    })
    .select()
    .single();
  if (errAgendamento) return res.status(500).json({ erro: errAgendamento.message });

  const { error: errUpdate } = await req.supabase
    .from('solicitacoes_agendamento')
    .update({ status: 'confirmado', agendamento_id: agendamento.id })
    .eq('id', req.params.id);
  if (errUpdate) return res.status(500).json({ erro: errUpdate.message });

  res.json(agendamento);

  const dataFormatada = inicio.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  const primeiroNome = solicitacao.clientes?.nome?.split(' ')[0] || '';
  const texto = `${primeiroNome ? primeiroNome + ', tudo' : 'Tudo'} certo! Seu horário pra ${solicitacao.estabelecimento_atividades?.nome || 'o atendimento'} ficou confirmado pra ${dataFormatada}. Te esperamos por aqui 😊`;
  enviarMensagemWhatsApp({ telefone: solicitacao.clientes?.telefone, texto, estabelecimentoId: req.params.id }).catch(erro =>
    console.error('Falha ao confirmar agendamento por WhatsApp:', erro.message)
  );
});

// POST /solicitacoes-agendamento/:id/propor-horario
// Body: { data_hora_proposta } — manda WhatsApp com o novo horário
// sugerido, em linguagem natural, e fica aguardando a resposta do
// cliente (tratada pela IA no webhook, ver aguardandoRespostaProposta).
router.post('/solicitacoes-agendamento/:id/propor-horario', async (req, res) => {
  const { data_hora_proposta } = req.body;
  if (!data_hora_proposta) return res.status(400).json({ erro: 'data_hora_proposta é obrigatório.' });

  const { data: solicitacao, error: errBusca } = await req.supabase
    .from('solicitacoes_agendamento')
    .select('*, clientes(nome, telefone), estabelecimento_atividades(nome)')
    .eq('id', req.params.id)
    .single();
  if (errBusca || !solicitacao) return res.status(404).json({ erro: 'Solicitação não encontrada.' });
  if (solicitacao.status === 'confirmado') return res.status(400).json({ erro: 'Essa solicitação já foi confirmada.' });

  const { error: errUpdate } = await req.supabase
    .from('solicitacoes_agendamento')
    .update({ status: 'horario_proposto', data_hora_proposta })
    .eq('id', req.params.id);
  if (errUpdate) return res.status(500).json({ erro: errUpdate.message });

  res.sendStatus(204);

  gerarMensagemPropostaHorario({
    nomeCliente: solicitacao.clientes?.nome,
    nomeServico: solicitacao.estabelecimento_atividades?.nome,
    dataHoraProposta: data_hora_proposta,
  }).then(texto =>
    enviarMensagemWhatsApp({ telefone: solicitacao.clientes?.telefone, texto, estabelecimentoId: req.params.id })
  ).catch(erro => console.error('Falha ao propor horário por WhatsApp:', erro.message));
});

module.exports = router;
