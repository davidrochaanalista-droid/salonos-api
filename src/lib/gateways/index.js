const mercadopago = require('./mercadopago');
const asaas = require('./asaas');
const efi = require('./efi');

const ADAPTERS = { mercadopago, asaas, efi };

function obterAdapter(gatewayPagamento) {
  const adapter = ADAPTERS[gatewayPagamento];
  if (!adapter) throw new Error(`Gateway de pagamento não suportado: ${gatewayPagamento}`);
  return adapter;
}

module.exports = { obterAdapter };
