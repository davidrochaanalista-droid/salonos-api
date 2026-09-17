/**
 * SalonOS API — Rotas de Proprietários
 * =====================================
 * Igual ao resto: usa req.supabase (escopado ao token do usuário), RLS
 * garante que só vê o próprio cadastro.
 */

const express = require('express');
const router = express.Router();

// GET /proprietarios/me — dado do proprietário logado (usado pelo
// painel-proprietario.html pra exibir nome/plano/desde no topo)
router.get('/proprietarios/me', async (req, res) => {
  const { data, error } = await req.supabase
    .from('proprietarios')
    .select('nome, telefone, created_at')
    .eq('user_id', req.user.id)
    .single();

  if (error) return res.status(404).json({ erro: 'Cadastro de proprietário não encontrado para este usuário.' });
  res.json(data);
});

// PATCH /proprietarios/me — completa nome/telefone reais depois de
// definir senha via convite (ver cadastro-real.html) -- o trigger
// criar_proprietario_no_signup já cria a linha no momento do convite,
// mas sem metadata nenhuma. Exige a policy de update da migração 29.
router.patch('/proprietarios/me', async (req, res) => {
  const camposPermitidos = ['nome', 'telefone'];
  const atualizacoes = {};
  for (const campo of camposPermitidos) {
    if (req.body[campo] !== undefined) atualizacoes[campo] = req.body[campo];
  }

  const { data, error } = await req.supabase
    .from('proprietarios')
    .update(atualizacoes)
    .eq('user_id', req.user.id)
    .select('nome, telefone, created_at')
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

module.exports = router;
