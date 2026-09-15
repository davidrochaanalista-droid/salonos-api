/**
 * SalonOS — Adapter de gateway: Mercado Pago (Pix dinâmico)
 * ==============================================================
 * Cada estabelecimento usa o PRÓPRIO access_token (colado no Config,
 * gerado no dashboard de Mercado Pago do dono -- nunca um token da
 * plataforma) -- o Bearer já escopa tudo pra conta dele, sem OAuth.
 *
 * Verificação de webhook: header x-signature ("ts=...,v1=..."), HMAC-
 * SHA256 do manifest "id:<data.id>;request-id:<x-request-id>;ts:<ts>;"
 * usando o webhook_secret configurado no dashboard do dono (Your
 * integrations > Webhooks). Depois de validar a assinatura, o status
 * NUNCA é confiado direto do corpo do webhook -- sempre reconsultado via
 * GET /v1/payments/:id com o access_token, só "approved" conta como
 * pago. (docs.mercadopago.com.br/developers, checkout-api-payments)
 */

const crypto = require('crypto');

const BASE_URL = 'https://api.mercadopago.com';

async function criarCobranca({ credenciais, valor, comandaId, descricao, estabelecimentoId }) {
  const notificationUrl = `${process.env.PUBLIC_BASE_URL}/webhooks/pix/mercadopago/${estabelecimentoId}`;

  const resposta = await fetch(`${BASE_URL}/v1/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credenciais.access_token}`,
      'X-Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({
      transaction_amount: Number(valor),
      description: descricao,
      payment_method_id: 'pix',
      external_reference: comandaId,
      notification_url: notificationUrl,
      // MP exige um payer -- não temos e-mail real do cliente na maioria
      // dos casos (só telefone), então usa um placeholder fixo só pra
      // identificação; não é usado pra contato de verdade.
      payer: { email: 'pagamento@salonos.app' },
    }),
  });

  const dados = await resposta.json();
  if (!resposta.ok) {
    throw new Error(`Mercado Pago recusou a cobrança: ${dados.message || resposta.status}`);
  }

  const transacao = dados.point_of_interaction?.transaction_data;
  if (!transacao?.qr_code) throw new Error('Mercado Pago não devolveu o QR code Pix na resposta.');

  return {
    cobrancaIdExterno: String(dados.id),
    copiaCola: transacao.qr_code,
    qrDataUrl: transacao.qr_code_base64 ? `data:image/png;base64,${transacao.qr_code_base64}` : null,
  };
}

function verificarWebhook(req, credenciais) {
  const assinatura = req.headers['x-signature'];
  const requestId = req.headers['x-request-id'];
  const dataId = req.query['data.id'] || req.body?.data?.id;
  if (!assinatura || !requestId || !dataId || !credenciais.webhook_secret) return false;

  const partes = Object.fromEntries(String(assinatura).split(',').map(p => p.trim().split('=')));
  if (!partes.ts || !partes.v1) return false;

  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${partes.ts};`;
  const esperado = crypto.createHmac('sha256', credenciais.webhook_secret).update(manifest).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(partes.v1));
  } catch {
    return false; // tamanhos diferentes -- claramente não bate
  }
}

// Nunca confia no status que vem no corpo do webhook -- sempre reconsulta
// o pagamento de verdade via API antes de considerar aprovado.
async function extrairEventoPago(req, credenciais) {
  const dataId = req.query['data.id'] || req.body?.data?.id;
  if (!dataId) return null;

  const resposta = await fetch(`${BASE_URL}/v1/payments/${dataId}`, {
    headers: { Authorization: `Bearer ${credenciais.access_token}` },
  });
  if (!resposta.ok) return null;
  const pagamento = await resposta.json();

  return {
    cobrancaIdExterno: String(pagamento.id),
    aprovado: pagamento.status === 'approved',
  };
}

module.exports = { criarCobranca, verificarWebhook, extrairEventoPago };
