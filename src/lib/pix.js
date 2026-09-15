/**
 * SalonOS — Pix Copia-e-Cola (pagamento antecipado)
 * =====================================================
 * Sem gateway, sem confirmação automática -- o dono cadastra a própria
 * chave Pix (src/routes/estabelecimentos.js) e o sistema gera um BR Code
 * estático (Copia-e-Cola) pra mandar pro cliente. NUNCA embute valor
 * (transactionAmount fica de fora de propósito) -- quem decide o valor
 * do sinal continua sendo a equipe combinando com o cliente, mesmo
 * princípio já em produção no prompt da IA. Sem valor fixo, também não
 * tem confirmação automática de pagamento possível -- o dono confere no
 * próprio app do banco, isso é esperado e aceito pro MVP.
 *
 * A lib não valida o FORMATO da chave (CPF/CNPJ/e-mail/telefone/chave
 * aleatória) -- aceita qualquer string e monta o BR Code mesmo assim.
 * Consistente com o resto do cadastro do estabelecimento (CNPJ também
 * não tem validação de formato), não adiciono validação própria aqui.
 */

const { createStaticPix, hasError } = require('pix-utils');

// merchantName tem limite de 25 caracteres no padrão BR Code -- corta
// sem erro em vez de deixar a lib falhar num nome de salão comprido.
function gerarPixCopiaECola({ chavePix, nomeEstabelecimento, cidade }) {
  if (!chavePix) return null;

  const pix = createStaticPix({
    pixKey: chavePix,
    merchantName: (nomeEstabelecimento || 'Salao').slice(0, 25),
    merchantCity: (cidade || 'BRASIL').slice(0, 15),
  });
  if (hasError(pix)) return null;

  return pix;
}

// Copia-e-cola (texto) -- o que dá pra mandar via WhatsApp hoje
// (enviarTexto em lib/evolution-api.js só manda texto, sem mídia).
function gerarCopiaECola(args) {
  const pix = gerarPixCopiaECola(args);
  return pix ? pix.toBRCode() : null;
}

// Imagem do QR (data URL base64) -- usada só no painel (visualização/
// impressão pro balcão), não enviada por WhatsApp nesta versão.
async function gerarImagemQr(args) {
  const pix = gerarPixCopiaECola(args);
  return pix ? await pix.toImage() : null;
}

module.exports = { gerarCopiaECola, gerarImagemQr };
