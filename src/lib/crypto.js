/**
 * SalonOS — Criptografia de dado sensível em camada de aplicação
 * =================================================================
 * Implementa a função especificada em docs/blueprint-backend-salonos.md,
 * seção 4. Isso existe porque RLS protege contra outro usuário lendo o
 * dado por engano — não protege contra vazamento de backup ou dump de
 * banco. Ficha técnica (fórmula, alergia, observação) precisa dessa
 * camada extra antes de dado real de cliente entrar em produção.
 *
 * Formato armazenado: "<iv_hex>:<tag_hex>:<dado_cifrado_hex>"
 * (um único campo TEXT, sem precisar de colunas extras no banco).
 */
const crypto = require('crypto');

const ALGORITMO = 'aes-256-gcm';

function obterChave() {
  const chaveHex = process.env.CRYPTO_KEY;
  if (!chaveHex) {
    throw new Error('CRYPTO_KEY não configurada (esperado: 64 caracteres hex = 32 bytes).');
  }
  const chave = Buffer.from(chaveHex, 'hex');
  if (chave.length !== 32) {
    throw new Error('CRYPTO_KEY precisa ter exatamente 32 bytes (64 caracteres hex).');
  }
  return chave;
}

function encryptSensitive(textoPlano) {
  if (textoPlano === null || textoPlano === undefined || textoPlano === '') return null;
  const chave = obterChave();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITMO, chave, iv);
  const cifrado = Buffer.concat([cipher.update(String(textoPlano), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${cifrado.toString('hex')}`;
}

function decryptSensitive(valorArmazenado) {
  if (!valorArmazenado) return null;
  const partes = valorArmazenado.split(':');
  if (partes.length !== 3) return null; // dado legado/corrompido -- não quebra a requisição
  const [ivHex, tagHex, dadoHex] = partes;
  const chave = obterChave();
  const decipher = crypto.createDecipheriv(ALGORITMO, chave, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decifrado = Buffer.concat([decipher.update(Buffer.from(dadoHex, 'hex')), decipher.final()]);
  return decifrado.toString('utf8');
}

module.exports = { encryptSensitive, decryptSensitive };
