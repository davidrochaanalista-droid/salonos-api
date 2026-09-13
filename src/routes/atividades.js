/**
 * SalonOS API — Rotas de Segmentos e Atividades
 * ================================================
 * Segmentos e catálogo são de leitura pública (RLS permite select
 * sem restrição — ver schema, seção 7). As demais rotas exigem que
 * o estabelecimento pertença ao usuário logado, garantido pelo RLS
 * de estabelecimento_atividades.
 */

const express = require('express');
const router = express.Router();

// GET /segmentos — lista os segmentos disponíveis para venda (para a tela de cadastro)
// Segmentos de saúde regulada (nutricionista, psicologia, odontologia,
// fisioterapia) ficam marcados `ativo = false` por decisão consciente —
// ver database/06-desativar-segmentos-saude-regulada.sql.
router.get('/segmentos', async (req, res) => {
  const { data, error } = await req.supabase
    .from('segmentos')
    .select('*')
    .eq('ativo', true)
    .order('ordem');

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// GET /atividades-catalogo?segmento_id=... — catálogo sugerido para um segmento
router.get('/atividades-catalogo', async (req, res) => {
  const { segmento_id } = req.query;
  if (!segmento_id) return res.status(400).json({ erro: 'segmento_id é obrigatório.' });

  const { data, error } = await req.supabase
    .from('atividades_catalogo')
    .select('*')
    .eq('segmento_id', segmento_id)
    .order('ordem');

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// GET /estabelecimentos/:id/atividades — atividades já vinculadas ao estabelecimento
router.get('/estabelecimentos/:id/atividades', async (req, res) => {
  const { data, error } = await req.supabase
    .from('estabelecimento_atividades')
    .select('*')
    .eq('estabelecimento_id', req.params.id)
    .order('created_at');

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// POST /estabelecimentos/:id/atividades — adota uma atividade do catálogo, ou cadastra customizada
// Body: { atividade_catalogo_id? , nome, descricao?, duracao_min?, preco }
router.post('/estabelecimentos/:id/atividades', async (req, res) => {
  const { atividade_catalogo_id, nome, descricao, duracao_min, preco } = req.body;
  if (!nome || preco === undefined) {
    return res.status(400).json({ erro: 'nome e preco são obrigatórios.' });
  }

  const { data, error } = await req.supabase
    .from('estabelecimento_atividades')
    .insert({
      estabelecimento_id: req.params.id,
      atividade_catalogo_id: atividade_catalogo_id || null,
      nome, descricao, duracao_min, preco,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.status(201).json(data);
});

// POST /estabelecimentos/:id/atividades/adotar-catalogo-completo — atalho para
// o cadastro inicial: adota TODAS as atividades sugeridas do segmento de uma vez,
// o proprietário depois remove/edita o que não quiser (fluxo descrito no README-fase1.md, Decisão 1)
router.post('/estabelecimentos/:id/atividades/adotar-catalogo-completo', async (req, res) => {
  const { data: estabelecimento, error: errEst } = await req.supabase
    .from('estabelecimentos')
    .select('segmento_id')
    .eq('id', req.params.id)
    .single();

  if (errEst || !estabelecimento) return res.status(404).json({ erro: 'Estabelecimento não encontrado.' });

  const { data: catalogo, error: errCat } = await req.supabase
    .from('atividades_catalogo')
    .select('*')
    .eq('segmento_id', estabelecimento.segmento_id);

  if (errCat) return res.status(500).json({ erro: errCat.message });

  const inserts = catalogo.map(a => ({
    estabelecimento_id: req.params.id,
    atividade_catalogo_id: a.id,
    nome: a.nome,
    descricao: a.descricao_curta,
    duracao_min: a.duracao_padrao_min,
    preco: a.preco_sugerido_min, // proprietário ajusta depois; usamos o piso da faixa como ponto de partida
  }));

  const { data, error } = await req.supabase
    .from('estabelecimento_atividades')
    .insert(inserts)
    .select();

  if (error) return res.status(500).json({ erro: error.message });
  res.status(201).json(data);
});

// PATCH /atividades/:id — editar preço/duração/status de uma atividade já vinculada
router.patch('/atividades/:id', async (req, res) => {
  const camposPermitidos = ['nome', 'descricao', 'duracao_min', 'preco', 'ativo', 'ciclo_recompra_dias'];
  const atualizacoes = {};
  for (const campo of camposPermitidos) {
    if (req.body[campo] !== undefined) atualizacoes[campo] = req.body[campo];
  }

  const { data, error } = await req.supabase
    .from('estabelecimento_atividades')
    .update(atualizacoes)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

module.exports = router;
