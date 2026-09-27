/**
 * Sinal de remarcação pelo WhatsApp (pedido do David, 26/09/2026): 30% do
 * preço do procedimento, e a IA só fala o valor em reais -- nunca a
 * porcentagem. Ver valorSinalRemarcacao/montarSystemPrompt em src/routes/whatsapp.js.
 */

const { montarSystemPrompt } = require('../src/routes/whatsapp');
const { valorSinalRemarcacao } = require('../src/lib/remarcacao');

describe('valorSinalRemarcacao', () => {
  test('30% do preço', () => {
    expect(valorSinalRemarcacao(80)).toBe(24);
    expect(valorSinalRemarcacao('150')).toBe(45);
  });
  test('arredonda pra cima no centavo (nunca cobra menos que 30%)', () => {
    expect(valorSinalRemarcacao(35.5)).toBe(10.65);
    expect(valorSinalRemarcacao(33.33)).toBe(10); // 9.999 -> 10.00
  });
  test('sem preço cadastrado: null', () => {
    expect(valorSinalRemarcacao(null)).toBeNull();
    expect(valorSinalRemarcacao(0)).toBeNull();
  });
});

describe('prompt com agendamentos já marcados', () => {
  const base = {
    estabelecimento: { nome: 'Studio', segmento_nome: 'Cabeleireiro', horario_abertura: '00:00', horario_fechamento: '23:59', dias_funcionamento: ['seg'] },
    atividades: [], nomeCliente: 'Beatriz', chavePix: 'x@y.com',
  };

  test('mostra o valor do sinal em reais e nunca a porcentagem', () => {
    const prompt = montarSystemPrompt({
      ...base,
      proximosAgendamentos: [{ id: 'a1', inicio: '2026-10-03T18:00:00.000Z', estabelecimento_atividades: { nome: 'Corte Feminino', preco: 80 }, profissionais: { nome: 'Camila' } }],
    });
    expect(prompt).toContain('Corte Feminino');
    expect(prompt).toContain('sinal pra remarcar: R$ 24,00 (ainda não pago)');
    expect(prompt).toContain('[ref: a1]');
    expect(prompt).toContain('REMARCAÇÃO');
    expect(prompt).not.toMatch(/30\s?%|trinta por cento/i);
  });

  test('sem agendamento marcado, não inclui a regra de remarcação', () => {
    const prompt = montarSystemPrompt({ ...base, proximosAgendamentos: [] });
    expect(prompt).not.toContain('IMPORTANTE -- REMARCAÇÃO');
  });
});
