/**
 * SalonOS API — Rotas de Caixa
 * ==============================
 * Entradas nascem automaticamente quando uma comanda é fechada (ver
 * routes/comandas.js), ou manualmente aqui para lançamento avulso
 * (ex.: saída para compra de insumo, sangria). Cada insert na tabela
 * dispara pg_notify (trg_caixa_notify) no canal `caixa_<estabelecimento_id>`
 * -- é isso que sustenta o "ao vivo" real (blueprint seção 5), diferente
 * do `setInterval` fake que os painéis usam hoje.
 */

const express = require('express');
const router = express.Router();

// POST /estabelecimentos/:id/caixa — lançamento avulso (entrada ou saída)
router.post('/estabelecimentos/:id/caixa', async (req, res) => {
  const { tipo, valor, forma_pagamento, descricao } = req.body;
  if (!tipo || !valor) return res.status(400).json({ erro: 'tipo e valor são obrigatórios.' });
  if (!['entrada', 'saida'].includes(tipo)) return res.status(400).json({ erro: "tipo precisa ser 'entrada' ou 'saida'." });

  const { data, error } = await req.supabase
    .from('caixa_entradas')
    .insert({ estabelecimento_id: req.params.id, tipo, valor, forma_pagamento, descricao })
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.status(201).json(data);
});

// GET /estabelecimentos/:id/caixa?desde=&ate= — extrato
router.get('/estabelecimentos/:id/caixa', async (req, res) => {
  const { desde, ate } = req.query;
  let consulta = req.supabase
    .from('caixa_entradas')
    .select('*')
    .eq('estabelecimento_id', req.params.id)
    .order('created_at', { ascending: false });

  if (desde) consulta = consulta.gte('created_at', desde);
  if (ate) consulta = consulta.lte('created_at', ate);

  const { data, error } = await consulta;
  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// GET /estabelecimentos/:id/caixa/resumo?desde=&ate= — soma entradas/saídas
// (padrão: dia corrente, horário do servidor)
router.get('/estabelecimentos/:id/caixa/resumo', async (req, res) => {
  const inicioDoDia = new Date();
  inicioDoDia.setHours(0, 0, 0, 0);

  const desde = req.query.desde || inicioDoDia.toISOString();
  const ate = req.query.ate || new Date().toISOString();

  const { data, error } = await req.supabase
    .from('caixa_entradas')
    .select('tipo, valor')
    .eq('estabelecimento_id', req.params.id)
    .gte('created_at', desde)
    .lte('created_at', ate);

  if (error) return res.status(500).json({ erro: error.message });

  const totalEntradas = data.filter(l => l.tipo === 'entrada').reduce((soma, l) => soma + Number(l.valor), 0);
  const totalSaidas = data.filter(l => l.tipo === 'saida').reduce((soma, l) => soma + Number(l.valor), 0);

  res.json({
    periodo: { desde, ate },
    total_entradas: totalEntradas,
    total_saidas: totalSaidas,
    saldo: totalEntradas - totalSaidas,
  });
});

module.exports = router;
