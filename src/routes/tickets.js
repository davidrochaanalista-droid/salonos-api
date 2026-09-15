/**
 * SalonOS API — Rotas de Central de Suporte (lado do dono do salão)
 * =====================================================================
 * req.supabase + RLS (ver database/27-tickets-suporte.sql): o dono só
 * vê/abre os próprios chamados. Responder/mudar status é só admin --
 * ver GET/PATCH /admin/tickets em src/routes/admin.js.
 */

const express = require('express');
const router = express.Router();

// POST /estabelecimentos/:id/tickets — abrir um chamado
router.post('/estabelecimentos/:id/tickets', async (req, res) => {
  const { assunto, mensagem, prioridade } = req.body;
  if (!assunto || !mensagem) return res.status(400).json({ erro: 'assunto e mensagem são obrigatórios.' });

  const { data: proprietario, error: errProp } = await req.supabase
    .from('proprietarios')
    .select('id')
    .eq('user_id', req.user.id)
    .single();
  if (errProp || !proprietario) return res.status(404).json({ erro: 'Cadastro de proprietário não encontrado para este usuário.' });

  const { data, error } = await req.supabase
    .from('tickets_suporte')
    .insert({
      estabelecimento_id: req.params.id,
      proprietario_id: proprietario.id,
      assunto,
      mensagem,
      prioridade: prioridade || 'media',
    })
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.status(201).json(data);
});

// GET /estabelecimentos/:id/tickets — os chamados do próprio salão
router.get('/estabelecimentos/:id/tickets', async (req, res) => {
  const { data, error } = await req.supabase
    .from('tickets_suporte')
    .select('id, assunto, mensagem, prioridade, status, resposta_admin, created_at, respondido_em')
    .eq('estabelecimento_id', req.params.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

module.exports = router;
