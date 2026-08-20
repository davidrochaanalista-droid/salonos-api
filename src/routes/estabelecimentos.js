/**
 * SalonOS API — Rotas de Estabelecimentos
 * =========================================
 * Todas as queries usam req.supabase (cliente escopado ao token do
 * usuário — ver middleware/auth.js), então o RLS do Postgres já
 * garante que um proprietário só vê/edita os próprios estabelecimentos.
 */

const express = require('express');
const router = express.Router();

// POST /estabelecimentos — cadastrar novo estabelecimento
router.post('/', async (req, res) => {
  const { segmento_id, nome, whatsapp, cnpj, cidade, bairro, endereco, cep, horario_abertura, horario_fechamento, dias_funcionamento } = req.body;

  if (!segmento_id || !nome || !whatsapp) {
    return res.status(400).json({ erro: 'segmento_id, nome e whatsapp são obrigatórios.' });
  }

  // Busca o proprietario_id vinculado ao usuário logado (criado automaticamente
  // no signup pelo trigger criar_proprietario_no_signup — ver schema, seção 8)
  const { data: proprietario, error: errProp } = await req.supabase
    .from('proprietarios')
    .select('id')
    .eq('user_id', req.user.id)
    .single();

  if (errProp || !proprietario) {
    return res.status(404).json({ erro: 'Cadastro de proprietário não encontrado para este usuário.' });
  }

  const { data, error } = await req.supabase
    .from('estabelecimentos')
    .insert({
      proprietario_id: proprietario.id,
      segmento_id, nome, whatsapp, cnpj, cidade, bairro, endereco, cep,
      horario_abertura, horario_fechamento, dias_funcionamento,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.status(201).json(data);
});

// GET /estabelecimentos — lista os estabelecimentos do proprietário logado
router.get('/', async (req, res) => {
  const { data, error } = await req.supabase
    .from('estabelecimentos')
    .select('*, segmentos(nome, slug, icone)')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// GET /estabelecimentos/:id — detalhe de um estabelecimento
router.get('/:id', async (req, res) => {
  const { data, error } = await req.supabase
    .from('estabelecimentos')
    .select('*, segmentos(nome, slug, icone)')
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(404).json({ erro: 'Estabelecimento não encontrado ou sem permissão de acesso.' });
  res.json(data);
});

// PATCH /estabelecimentos/:id — editar dados do estabelecimento
router.patch('/:id', async (req, res) => {
  const camposPermitidos = ['nome', 'whatsapp', 'cnpj', 'cidade', 'bairro', 'endereco', 'cep', 'horario_abertura', 'horario_fechamento', 'dias_funcionamento', 'plano'];
  const atualizacoes = {};
  for (const campo of camposPermitidos) {
    if (req.body[campo] !== undefined) atualizacoes[campo] = req.body[campo];
  }

  const { data, error } = await req.supabase
    .from('estabelecimentos')
    .update(atualizacoes)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

module.exports = router;
