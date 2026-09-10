/**
 * SalonOS API — Rotas de Profissionais
 * ======================================
 * A tabela existe desde a migração 03 (histórico de atendimento), mas
 * não tinha endpoint próprio ainda. `comissao_padrao_percentual` (migração
 * 05) é o valor usado por padrão ao fechar uma comanda, salvo sobrescrita
 * item a item (ver routes/comandas.js).
 */

const express = require('express');
const router = express.Router();

// POST /estabelecimentos/:id/profissionais — cadastrar profissional
router.post('/estabelecimentos/:id/profissionais', async (req, res) => {
  const { nome, comissao_padrao_percentual } = req.body;
  if (!nome) return res.status(400).json({ erro: 'nome é obrigatório.' });

  const { data, error } = await req.supabase
    .from('profissionais')
    .insert({ estabelecimento_id: req.params.id, nome, comissao_padrao_percentual: comissao_padrao_percentual || 0 })
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.status(201).json(data);
});

// GET /estabelecimentos/:id/profissionais — lista profissionais do estabelecimento
router.get('/estabelecimentos/:id/profissionais', async (req, res) => {
  const { data, error } = await req.supabase
    .from('profissionais')
    .select('*')
    .eq('estabelecimento_id', req.params.id)
    .order('nome');

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// PATCH /profissionais/:id — editar nome/comissão/status
router.patch('/profissionais/:id', async (req, res) => {
  const camposPermitidos = ['nome', 'comissao_padrao_percentual', 'ativo'];
  const atualizacoes = {};
  for (const campo of camposPermitidos) {
    if (req.body[campo] !== undefined) atualizacoes[campo] = req.body[campo];
  }

  const { data, error } = await req.supabase
    .from('profissionais')
    .update(atualizacoes)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

module.exports = router;
