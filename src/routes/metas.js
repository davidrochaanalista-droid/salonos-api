/**
 * SalonOS API — Metas mensais
 * =============================
 * Meta de receita por estabelecimento/mês, usada pra comparar "realizado
 * vs meta" no painel do proprietário (docs/README-api.md).
 */

const express = require('express');
const router = express.Router();

// POST /estabelecimentos/:id/metas — cria ou atualiza a meta de um mês
// Body: { ano_mes: '2026-09-01', valor_meta: 22000 }
router.post('/estabelecimentos/:id/metas', async (req, res) => {
  const { ano_mes, valor_meta } = req.body;
  if (!ano_mes || valor_meta === undefined) {
    return res.status(400).json({ erro: 'ano_mes e valor_meta são obrigatórios.' });
  }

  const { data, error } = await req.supabase
    .from('metas_mensais')
    .upsert(
      { estabelecimento_id: req.params.id, ano_mes, valor_meta },
      { onConflict: 'estabelecimento_id,ano_mes' }
    )
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.status(201).json(data);
});

// GET /estabelecimentos/:id/metas?ano_mes=2026-09-01 — meta de um mês
// específico (ou todas, se ano_mes não for informado)
router.get('/estabelecimentos/:id/metas', async (req, res) => {
  let consulta = req.supabase
    .from('metas_mensais')
    .select('*')
    .eq('estabelecimento_id', req.params.id)
    .order('ano_mes', { ascending: false });

  if (req.query.ano_mes) consulta = consulta.eq('ano_mes', req.query.ano_mes);

  const { data, error } = await consulta;
  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

module.exports = router;
