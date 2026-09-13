/**
 * SalonOS API — Lista de espera
 * ===============================
 * Cadastro manual pelo atendente (não existe agendamento self-service
 * pelo cliente) -- quando um agendamento daquela atividade é cancelado,
 * o motor de automações (routes/agenda.js) notifica o primeiro da fila.
 */

const express = require('express');
const router = express.Router();

// POST /estabelecimentos/:id/lista-espera
router.post('/estabelecimentos/:id/lista-espera', async (req, res) => {
  const { cliente_id, estabelecimento_atividade_id, profissional_id, observacao } = req.body;
  if (!cliente_id || !estabelecimento_atividade_id) {
    return res.status(400).json({ erro: 'cliente_id e estabelecimento_atividade_id são obrigatórios.' });
  }

  const { data, error } = await req.supabase
    .from('lista_espera')
    .insert({ estabelecimento_id: req.params.id, cliente_id, estabelecimento_atividade_id, profissional_id, observacao })
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.status(201).json(data);
});

// GET /estabelecimentos/:id/lista-espera?pendente=true
router.get('/estabelecimentos/:id/lista-espera', async (req, res) => {
  let consulta = req.supabase
    .from('lista_espera')
    .select('*, clientes(nome, telefone), estabelecimento_atividades(nome)')
    .eq('estabelecimento_id', req.params.id)
    .order('created_at');

  if (req.query.pendente === 'true') consulta = consulta.is('notificado_em', null);

  const { data, error } = await consulta;
  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

module.exports = router;
