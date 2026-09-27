/**
 * Testes de estabelecimento com vários segmentos -- validarSegmentos e
 * adotarCatalogoCompleto (src/routes/atividades.js), ver
 * database/38-multiplos-segmentos.sql.
 *
 * Nenhum teste bate no Supabase de verdade: o cliente é um dublê que
 * devolve uma resposta fixa por tabela e registra o que foi inserido.
 */

const { validarSegmentos, adotarCatalogoCompleto } = require('../src/routes/atividades');

function criarClienteFalso(respostasPorTabela) {
  const inseridos = [];
  const from = jest.fn((tabela) => {
    const builder = {};
    ['select', 'eq', 'in'].forEach((metodo) => { builder[metodo] = jest.fn(() => builder); });
    builder.insert = jest.fn((linhas) => {
      inseridos.push(...linhas);
      return { select: () => Promise.resolve({ data: linhas, error: null }) };
    });
    builder.then = (resolve, reject) =>
      Promise.resolve(respostasPorTabela[tabela] || { data: [], error: null }).then(resolve, reject);
    return builder;
  });
  return { from, inseridos };
}

const SEG_CABELO = '11111111-1111-1111-1111-111111111111';
const SEG_UNHA = '22222222-2222-2222-2222-222222222222';

describe('validarSegmentos', () => {
  const clienteComOsDois = () => criarClienteFalso({
    segmentos: { data: [{ id: SEG_CABELO }, { id: SEG_UNHA }], error: null },
  });

  test('aceita lista nova e mantém a ordem escolhida (primeiro = principal)', async () => {
    const ids = await validarSegmentos(clienteComOsDois(), { segmentos_ids: [SEG_UNHA, SEG_CABELO] });
    expect(ids).toEqual([SEG_UNHA, SEG_CABELO]);
  });

  test('aceita o formato antigo (segmento_id único)', async () => {
    const cliente = criarClienteFalso({ segmentos: { data: [{ id: SEG_CABELO }], error: null } });
    expect(await validarSegmentos(cliente, { segmento_id: SEG_CABELO })).toEqual([SEG_CABELO]);
  });

  test('remove repetidos', async () => {
    const ids = await validarSegmentos(clienteComOsDois(), { segmentos_ids: [SEG_CABELO, SEG_UNHA, SEG_CABELO] });
    expect(ids).toEqual([SEG_CABELO, SEG_UNHA]);
  });

  test('lista vazia vira erro 400', async () => {
    await expect(validarSegmentos(clienteComOsDois(), { segmentos_ids: [] }))
      .rejects.toMatchObject({ status: 400, message: 'Escolha pelo menos um segmento.' });
  });

  test('segmento inexistente ou inativo vira erro 400', async () => {
    const cliente = criarClienteFalso({ segmentos: { data: [{ id: SEG_CABELO }], error: null } });
    await expect(validarSegmentos(cliente, { segmentos_ids: [SEG_CABELO, SEG_UNHA] }))
      .rejects.toMatchObject({ status: 400 });
  });

  test('mais de 10 segmentos vira erro 400', async () => {
    const onze = Array.from({ length: 11 }, (_, i) => `seg-${i}`);
    await expect(validarSegmentos(clienteComOsDois(), { segmentos_ids: onze }))
      .rejects.toMatchObject({ status: 400 });
  });
});

describe('adotarCatalogoCompleto com vários segmentos', () => {
  test('junta o catálogo dos segmentos sem duplicar serviço de mesmo nome', async () => {
    const cliente = criarClienteFalso({
      atividades_catalogo: {
        data: [
          { id: 'a3', segmento_id: SEG_UNHA, nome: 'Manicure', descricao_curta: '', duracao_padrao_min: 40, preco_sugerido_min: 30, ordem: 1 },
          { id: 'a4', segmento_id: SEG_UNHA, nome: 'Hidratação', descricao_curta: 'da unha', duracao_padrao_min: 20, preco_sugerido_min: 15, ordem: 2 },
          { id: 'a1', segmento_id: SEG_CABELO, nome: 'Corte Feminino', descricao_curta: '', duracao_padrao_min: 60, preco_sugerido_min: 60, ordem: 1 },
          { id: 'a2', segmento_id: SEG_CABELO, nome: 'hidratação ', descricao_curta: 'do cabelo', duracao_padrao_min: 60, preco_sugerido_min: 60, ordem: 2 },
        ],
        error: null,
      },
    });

    await adotarCatalogoCompleto(cliente, 'est-1', [SEG_CABELO, SEG_UNHA]);

    // Segmento principal (cabelo) vem primeiro e vence o empate de nome.
    expect(cliente.inseridos.map(i => i.atividade_catalogo_id)).toEqual(['a1', 'a2', 'a3']);
    expect(cliente.inseridos.every(i => i.estabelecimento_id === 'est-1')).toBe(true);
  });

  test('continua aceitando um segmento só (chamada antiga)', async () => {
    const cliente = criarClienteFalso({
      atividades_catalogo: {
        data: [{ id: 'a1', segmento_id: SEG_CABELO, nome: 'Corte', descricao_curta: '', duracao_padrao_min: 60, preco_sugerido_min: 60, ordem: 1 }],
        error: null,
      },
    });
    await adotarCatalogoCompleto(cliente, 'est-1', SEG_CABELO);
    expect(cliente.inseridos).toHaveLength(1);
  });
});
