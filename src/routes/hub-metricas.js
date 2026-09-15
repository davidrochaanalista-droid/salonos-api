/**
 * SalonOS API — Métricas pra OmniFlow Studio (hub de gestão)
 * ==============================================================
 * Rota server-to-server: quem chama é o backend do hub OmniFlow
 * Studio, nunca um usuário logado -- por isso fica FORA de
 * `autenticar`/`exigirAdmin` (montada antes deles em server.js, mesmo
 * motivo do webhook do WhatsApp) e usa segredo compartilhado
 * (HUB_METRICS_KEY) em vez de JWT do Supabase Auth. Reaproveita
 * exatamente a mesma consulta de /admin/visao.
 */

const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const router = express.Router();

const supabaseServico = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function verificarChaveHub(chave) {
  if (!chave || !process.env.HUB_METRICS_KEY) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(chave), Buffer.from(process.env.HUB_METRICS_KEY));
  } catch {
    return false; // tamanhos diferentes -- claramente não bate
  }
}

router.get('/admin/hub-metricas', async (req, res) => {
  if (!verificarChaveHub(req.headers['x-hub-key'])) return res.sendStatus(401);

  const [{ data: estabelecimentos, error: errEst }, { data: precos, error: errPrecos }] = await Promise.all([
    supabaseServico.from('estabelecimentos').select('status_assinatura, plano'),
    supabaseServico.from('planos_precos').select('plano, valor_mensal'),
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
    contas_ativas: contagemPorStatus.ativo,
    contas_trial: contagemPorStatus.trial,
    contas_inadimplentes: contagemPorStatus.inadimplente,
    mrr_contratado: mrrContratado,
  });
});

module.exports = router;
