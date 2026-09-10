/**
 * SalonOS API — Rotas de Agenda
 * ===============================
 * Agendamento é o que está marcado para o futuro (distinto de
 * `atendimentos`, que registra o que já aconteceu, e é criado
 * automaticamente quando uma comanda vinculada é fechada — ver
 * routes/comandas.js e a função `fechar_comanda` no banco).
 */

const express = require('express');
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
});

module.exports = router;
