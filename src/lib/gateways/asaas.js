/**
 * SalonOS — Adapter de gateway: Asaas (Pix dinâmico)
 * ========================================================
 * Cada estabelecimento usa a PRÓPRIA api_key (colada no Config, gerada
 * no dashboard Asaas do dono) -- header `access_token`, sem OAuth.
 *
 * Verificação de webhook: header `asaas-access-token` precisa bater
 * exatamente com o `webhook_token` que o dono escolheu ao cadastrar o
 * webhook no dashboard Asaas (não é HMAC, é comparação direta de
 * segredo compartilhado). Entrega é "pelo menos uma vez" -- por isso
 * `cobrancas_pix.status` só muda de 'pendente' uma vez (ver rota do
 * webhook), tratando reentrega como idempotente.
 *
 * CPF/CNPJ do pagador: a API da Asaas pede isso pra criar o "customer"
 * -- o cadastro de cliente do SalonOS hoje não coleta CPF. Se faltar,
 * a chamada abaixo falha com o erro de validação da própria Asaas (não
 * inventamos um CPF pra contornar isso).
 *
 * Customer por cliente, não por comanda: `externalReference` do customer
 * usa o clienteId do SalonOS (não o comandaId) e a criação busca por esse
 * external reference antes de criar -- sem isso, cada "Cobrar via Pix"
 * pro mesmo cliente recorrente criava um customer novo na Asaas.
 */

const BASE_URL = 'https://api.asaas.com/v3';

async function obterOuCriarCliente({ headers, nomePagador, cpfCnpjPagador, clienteId }) {
  if (clienteId) {
    const respBusca = await fetch(`${BASE_URL}/customers?externalReference=${encodeURIComponent(clienteId)}`, { headers });
    const busca = await respBusca.json();
    if (respBusca.ok && busca.data?.length) return busca.data[0].id;
  }

  const respCliente = await fetch(`${BASE_URL}/customers`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: nomePagador || 'Cliente SalonOS', cpfCnpj: cpfCnpjPagador, externalReference: clienteId }),
  });
  const cliente = await respCliente.json();
  if (!respCliente.ok) throw new Error(`Asaas recusou o cliente: ${cliente.errors?.[0]?.description || respCliente.status}`);
  return cliente.id;
}

async function criarCobranca({ credenciais, valor, comandaId, descricao, nomePagador, cpfCnpjPagador, clienteId }) {
  const headers = {
    'Content-Type': 'application/json',
    access_token: credenciais.api_key,
  };

  const clienteAsaasId = await obterOuCriarCliente({ headers, nomePagador, cpfCnpjPagador, clienteId });

  const respCobranca = await fetch(`${BASE_URL}/payments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      customer: clienteAsaasId,
      billingType: 'PIX',
      value: Number(valor),
      dueDate: new Date().toISOString().slice(0, 10),
      description: descricao,
      externalReference: comandaId,
    }),
  });
  const cobranca = await respCobranca.json();
  if (!respCobranca.ok) throw new Error(`Asaas recusou a cobrança: ${cobranca.errors?.[0]?.description || respCobranca.status}`);

  const respQr = await fetch(`${BASE_URL}/payments/${cobranca.id}/pixQrCode`, { headers });
  const qr = await respQr.json();
  if (!respQr.ok) throw new Error(`Asaas não devolveu o QR Pix: ${qr.errors?.[0]?.description || respQr.status}`);

  return {
    cobrancaIdExterno: cobranca.id,
    copiaCola: qr.payload,
    qrDataUrl: qr.encodedImage ? `data:image/png;base64,${qr.encodedImage}` : null,
  };
}

function verificarWebhook(req, credenciais) {
  const token = req.headers['asaas-access-token'];
  return Boolean(token && credenciais.webhook_token && token === credenciais.webhook_token);
}

async function extrairEventoPago(req) {
  const evento = req.body?.event;
  const pagamento = req.body?.payment;
  if (!pagamento?.id) return null;
  // PAYMENT_RECEIVED = dinheiro de verdade na conta (Pix/boleto pulam
  // direto pra esse status, sem passar por PAYMENT_CONFIRMED).
  return { cobrancaIdExterno: pagamento.id, aprovado: evento === 'PAYMENT_RECEIVED' };
}

module.exports = { criarCobranca, verificarWebhook, extrairEventoPago };
