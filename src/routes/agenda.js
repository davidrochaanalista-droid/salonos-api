/**
 * SalonOS API — Rotas de Agenda
 * ===============================
 * Agendamento é o que está marcado para o futuro (distinto de
 * `atendimentos`, que registra o que já aconteceu, e é criado
 * automaticamente quando uma comanda vinculada é fechada — ver
 * routes/comandas.js e a função `fechar_comanda` no banco).
 */

const express = require('express');
const { enviarMensagemWhatsApp } = require('./whatsapp');
const router = express.Router();

// POST /estabelecimentos/:id/agendamentos — criar agendamento
router.post('/estabelecimentos/:id/agendamentos', async (req, res) => {
  const { cliente_id, profissional_id, estabelecimento_atividade_id, inicio, fim, origem, observacao } = req.body;
  if (!cliente_id || !estabelecimento_atividade_id || !inicio || !fim) {
    return res.status(400).json({ erro: 'cliente_id, estabelecimento_atividade_id, inicio e fim são obrigatórios.' });
  }

  const { data, error } = await req.supabase
    .from('agendamentos')
    .insert({
      estabelecimento_id: req.params.id,
      cliente_id, profissional_id, estabelecimento_atividade_id, inicio, fim,
      origem: origem || 'painel', observacao,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.status(201).json(data);

  dispararUpsell(req.supabase, req.params.id, data).catch(erro =>
    console.error('Falha ao disparar upsell de agendamento:', erro)
  );
});

// GET /estabelecimentos/:id/agendamentos?desde=&ate= — lista agendamentos num intervalo
router.get('/estabelecimentos/:id/agendamentos', async (req, res) => {
  const { desde, ate } = req.query;
  let consulta = req.supabase
    .from('agendamentos')
    .select('*, clientes(nome, telefone), profissionais(nome), estabelecimento_atividades(nome, duracao_min, preco)')
    .eq('estabelecimento_id', req.params.id)
    .order('inicio');

  if (desde) consulta = consulta.gte('inicio', desde);
  if (ate) consulta = consulta.lte('inicio', ate);

  const { data, error } = await consulta;
  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// PATCH /agendamentos/:id — editar horário/status/profissional
router.patch('/agendamentos/:id', async (req, res) => {
  const camposPermitidos = ['profissional_id', 'inicio', 'fim', 'status', 'observacao'];
  const atualizacoes = {};
  for (const campo of camposPermitidos) {
    if (req.body[campo] !== undefined) atualizacoes[campo] = req.body[campo];
  }

  const { data, error } = await req.supabase
    .from('agendamentos')
    .update(atualizacoes)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);

  if (atualizacoes.status === 'cancelado') {
    dispararListaEspera(req.supabase, data).catch(erro =>
      console.error('Falha ao disparar lista de espera:', erro)
    );
  }
});

// Manda uma sugestão de serviço extra assim que o salão cria um
// agendamento pro cliente (não existe agendamento self-service pelo
// cliente ainda -- então o "upsell no momento de agendar" vira isso:
// uma mensagem logo depois que o salão marca o horário).
async function dispararUpsell(supabase, estabelecimentoId, agendamento) {
  const { data: automacao } = await supabase
    .from('automacoes')
    .select('id, ativa')
    .eq('estabelecimento_id', estabelecimentoId)
    .eq('tipo', 'upsell_agendamento')
    .maybeSingle();
  if (!automacao?.ativa) return;

  const { data: jaDisparado } = await supabase
    .from('automacao_disparos')
    .select('id')
    .eq('automacao_id', automacao.id)
    .eq('referencia_id', agendamento.id)
    .limit(1);
  if (jaDisparado?.length) return;

  const { data: cliente } = await supabase.from('clientes').select('telefone, nome').eq('id', agendamento.cliente_id).single();
  if (!cliente?.telefone) return;

  const hora = new Date(agendamento.inicio).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const texto = `Agendamento confirmado pra ${hora}! Quer aproveitar e incluir outro serviço no mesmo horário? É só responder aqui que a gente vê a disponibilidade 💇`;
  await enviarMensagemWhatsApp({ telefone: cliente.telefone, texto });
  await supabase.from('automacao_disparos').insert({
    automacao_id: automacao.id, estabelecimento_id: estabelecimentoId, cliente_id: agendamento.cliente_id, referencia_id: agendamento.id,
  });
}

// Quando um agendamento é cancelado, oferece o horário liberado pro
// primeiro cliente da lista de espera daquela mesma atividade -- é só
// uma oferta por WhatsApp, o atendente confirma manualmente depois.
async function dispararListaEspera(supabase, agendamentoCancelado) {
  const { data: automacao } = await supabase
    .from('automacoes')
    .select('id, ativa')
    .eq('estabelecimento_id', agendamentoCancelado.estabelecimento_id)
    .eq('tipo', 'lista_espera')
    .maybeSingle();
  if (!automacao?.ativa) return;

  const { data: proximo } = await supabase
    .from('lista_espera')
    .select('id, cliente_id, clientes(nome, telefone)')
    .eq('estabelecimento_id', agendamentoCancelado.estabelecimento_id)
    .eq('estabelecimento_atividade_id', agendamentoCancelado.estabelecimento_atividade_id)
    .is('notificado_em', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!proximo?.clientes?.telefone) return;

  const dataFormatada = new Date(agendamentoCancelado.inicio).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const texto = `Oi, ${proximo.clientes.nome || 'tudo bem'}? Abriu um horário em ${dataFormatada} pro serviço que você esperava. Quer que a gente reserve pra você?`;
  await enviarMensagemWhatsApp({ telefone: proximo.clientes.telefone, texto });
  await supabase.from('lista_espera').update({ notificado_em: new Date().toISOString() }).eq('id', proximo.id);
  await supabase.from('automacao_disparos').insert({
    automacao_id: automacao.id, estabelecimento_id: agendamentoCancelado.estabelecimento_id, cliente_id: proximo.cliente_id, referencia_id: proximo.id,
  });
}

module.exports = router;
