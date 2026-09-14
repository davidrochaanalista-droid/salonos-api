/**
 * SalonOS API — Rotas do painel administrativo interno
 * =========================================================
 * Todas as rotas aqui passam por `autenticar` + `exigirAdmin` (montado
 * em server.js) -- usam req.supabaseAdmin (service_role, cross-tenant
 * de propósito), nunca req.supabase. Ver src/middleware/exigirAdmin.js.
 *
 * Escopo desta entrega (14/09/2026): só Contas e Visão Geral têm dado
 * real pra mostrar (estabelecimentos/proprietarios/status_assinatura/
 * planos_precos já existem). Financeiro, Suporte e Auditoria & LGPD
 * não têm sistema real por trás ainda (sem gateway de pagamento, sem
 * tabela de ticket, sem log de acesso) -- ficam "em breve" no frontend,
 * sem rota correspondente aqui, pelo mesmo princípio já usado no resto
 * do projeto: nenhuma seção mostra número inventado.
 */

const express = require('express');
const router = express.Router();

// GET /admin/me — confirma pro frontend que o usuário logado é admin
router.get('/admin/me', (req, res) => {
  res.json({ admin: true });
});

// GET /admin/contas — lista todas as contas da plataforma
router.get('/admin/contas', async (req, res) => {
  const { data, error } = await req.supabaseAdmin
    .from('estabelecimentos')
    .select('id, nome, cidade, plano, status_assinatura, created_at, proprietarios(nome, telefone)')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// GET /admin/visao — contagens por status + MRR contratado somado
router.get('/admin/visao', async (req, res) => {
  const [{ data: estabelecimentos, error: errEst }, { data: precos, error: errPrecos }] = await Promise.all([
    req.supabaseAdmin.from('estabelecimentos').select('status_assinatura, plano'),
    req.supabaseAdmin.from('planos_precos').select('plano, valor_mensal'),
  ]);
  if (errEst) return res.status(500).json({ erro: errEst.message });
  if (errPrecos) return res.status(500).json({ erro: errPrecos.message });

  const valorPorPlano = Object.fromEntries(precos.map((p) => [p.plano, Number(p.valor_mensal)]));

  const contagemPorStatus = { trial: 0, ativo: 0, inadimplente: 0, cancelado: 0 };
  let mrrContratado = 0;
  for (const e of estabelecimentos) {
    if (contagemPorStatus[e.status_assinatura] !== undefined) contagemPorStatus[e.status_assinatura] += 1;
    if (e.status_assinatura === 'ativo') mrrContratado += valorPorPlano[e.plano] || 0;
  }

  res.json({
    total_contas: estabelecimentos.length,
    contagem_por_status: contagemPorStatus,
    mrr_contratado: mrrContratado,
  });
});

module.exports = router;
