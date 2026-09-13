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

module.exports = router;
