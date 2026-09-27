/**
 * Informações do salão pro prompt da IA (database/41-informacoes-salao-ia.sql):
 * endereço, estacionamento, manobrista e texto livre. Antes a IA não
 * recebia nem o endereço -- e inventou estacionamento num teste real.
 */

const { montarSystemPrompt } = require('../src/routes/whatsapp');

const base = {
  atividades: [], nomeCliente: 'Beatriz', chavePix: null,
};
const estabelecimento = (extra) => ({
  nome: 'Studio', segmento_nome: 'Cabeleireiro', horario_abertura: '09:00', horario_fechamento: '19:00', dias_funcionamento: ['seg'], ...extra,
});

test('manda endereço completo, estacionamento, manobrista e outras informações', () => {
  const prompt = montarSystemPrompt({
    ...base,
    estabelecimento: estabelecimento({
      endereco: 'Rua das Flores, 123', bairro: 'Jardins', cidade: 'São Paulo', cep: '01400-000',
      estacionamento: 'conveniado', manobrista: true, info_extra_ia: 'Temos wi-fi e acesso para cadeirantes.',
    }),
  });
  expect(prompt).toContain('- Endereço: Rua das Flores, 123, Jardins, São Paulo (CEP 01400-000)');
  expect(prompt).toContain('- Estacionamento: estacionamento conveniado');
  expect(prompt).toContain('- Manobrista: tem manobrista');
  expect(prompt).toContain('- Outras informações: Temos wi-fi e acesso para cadeirantes.');
});

test('em branco vira "não informado" (IA confirma com a equipe), e false é "não tem"', () => {
  const prompt = montarSystemPrompt({ ...base, estabelecimento: estabelecimento({ manobrista: false }) });
  expect(prompt).toContain('- Endereço: não informado');
  expect(prompt).toContain('- Estacionamento: não informado');
  expect(prompt).toContain('- Manobrista: não tem manobrista');
  expect(prompt).not.toContain('Outras informações:');
});
