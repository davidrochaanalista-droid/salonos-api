const { encryptSensitive, decryptSensitive } = require('../src/lib/crypto');

describe('encryptSensitive / decryptSensitive', () => {
  it('faz round-trip corretamente', () => {
    const original = 'Alérgica a amônia, prefere tons frios';
    const cifrado = encryptSensitive(original);
    expect(cifrado).not.toBe(original);
    expect(decryptSensitive(cifrado)).toBe(original);
  });

  it('retorna null para valor vazio', () => {
    expect(encryptSensitive('')).toBeNull();
    expect(encryptSensitive(null)).toBeNull();
    expect(decryptSensitive(null)).toBeNull();
  });

  it('não quebra com dado legado/corrompido (formato inesperado)', () => {
    expect(decryptSensitive('texto-plano-sem-formato')).toBeNull();
  });
});
