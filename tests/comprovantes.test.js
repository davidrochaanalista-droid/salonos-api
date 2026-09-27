/**
 * Testes do comprovante de pagamento antecipado (src/lib/comprovantes.js,
 * database/39-comprovante-pagamento-antecipado.sql). Supabase, Groq e
 * Evolution são dublês -- nada bate na rede.
 */

const { processarComprovante, valorEsperado } = require('../src/lib/comprovantes');

// Dublê do Supabase: a consulta de agendamentos devolve `agendamentos`;
// registra o update e o upload pra conferir o que foi gravado.
// A 1ª consulta a agendamentos é a de remarcação pendente (`remarcacao`,
// vazia por padrão); as seguintes devolvem `agendamentos`.
function criarSupabaseFalso(agendamentos, { remarcacao = [] } = {}) {
  const registro = { update: null, idsAtualizados: null, upload: null };
  let consultas = 0;
  const supabase = {
    from: jest.fn(() => {
      const builder = {};
      ['select', 'eq', 'is', 'not', 'gte', 'order', 'limit'].forEach(m => { builder[m] = jest.fn(() => builder); });
      builder.in = jest.fn(() => builder);
      builder.update = jest.fn((valores) => {
        registro.update = valores;
        return { in: jest.fn((coluna, ids) => { registro.idsAtualizados = ids; return Promise.resolve({ error: null }); }) };
      });
      builder.then = (resolve, reject) => {
        const data = consultas++ === 0 ? remarcacao : agendamentos;
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      };
      return builder;
    }),
    storage: {
      from: jest.fn(() => ({
        upload: jest.fn((caminho, conteudo, opcoes) => { registro.upload = { caminho, opcoes }; return Promise.resolve({ error: null }); }),
      })),
    },
  };
  return { supabase, registro };
}

function criarGroqFalso(leitura) {
  return { chat: { completions: { create: jest.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(leitura) } }] }) } } };
}

const evolutionComImagem = { baixarMidiaBase64: jest.fn().mockResolvedValue({ base64: Buffer.from('img').toString('base64'), mimetype: 'image/jpeg' }) };

// Dois serviços no mesmo dia (visita com serviços em sequência) + um em outro dia.
// Horários FIXOS de Brasília (10h e 11h de amanhã) -- "agora + 24h/25h"
// quebrava o teste rodando à noite (o 2º serviço caía depois da meia-noite).
const diaDeAmanhaSp = new Date(Date.now() + 24 * 3600e3).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const amanha = new Date(`${diaDeAmanhaSp}T10:00:00-03:00`);
const amanhaMaisTarde = new Date(`${diaDeAmanhaSp}T11:00:00-03:00`);
const semanaQueVem = new Date(Date.now() + 7 * 24 * 3600e3);
const agendamentos = [
  { id: 'ag-corte', inicio: amanha.toISOString(), estabelecimento_atividades: { nome: 'Corte', preco: 80 } },
  { id: 'ag-mao', inicio: amanhaMaisTarde.toISOString(), estabelecimento_atividades: { nome: 'Manicure', preco: 35 } },
  { id: 'ag-outro-dia', inicio: semanaQueVem.toISOString(), estabelecimento_atividades: { nome: 'Corte', preco: 80 } },
];

const base = { estabelecimentoId: 'est-1', cliente: { id: 'cli-1', nome: 'Beatriz Souza' }, mensagemId: 'msg-1', mimetype: 'image/jpeg' };

describe('processarComprovante', () => {
  test('valor igual à soma dos serviços do dia: marca pago e guarda o comprovante', async () => {
    const { supabase, registro } = criarSupabaseFalso(agendamentos);
    const r = await processarComprovante({ ...base, supabase, groq: criarGroqFalso({ e_comprovante: true, valor: 115 }), evolution: evolutionComImagem });

    expect(r).toMatchObject({ tratado: true, pago: true });
    expect(r.resposta).toMatch(/marcado como pago/);
    expect(registro.idsAtualizados).toEqual(['ag-corte', 'ag-mao']); // não mexe no de outro dia
    expect(registro.update.pago_antecipado_em).toBeTruthy();
    expect(registro.update.comprovante_valor_lido).toBe(115);
    expect(registro.update.comprovante_path).toMatch(/^est-1\/ag-corte-\d+\.jpg$/);
  });

  test('valor menor que o total: guarda, mas NÃO marca pago (equipe confere)', async () => {
    const { supabase, registro } = criarSupabaseFalso(agendamentos);
    const r = await processarComprovante({ ...base, supabase, groq: criarGroqFalso({ e_comprovante: true, valor: 80 }), evolution: evolutionComImagem });

    expect(r).toMatchObject({ tratado: true, pago: false });
    expect(r.resposta).toMatch(/equipe/);
    expect(registro.update.pago_antecipado_em).toBeNull();
    expect(registro.update.comprovante_recebido_em).toBeTruthy();
  });

  test('valor ilegível: não marca pago', async () => {
    const { supabase, registro } = criarSupabaseFalso(agendamentos);
    const r = await processarComprovante({ ...base, supabase, groq: criarGroqFalso({ e_comprovante: true, valor: null }), evolution: evolutionComImagem });
    expect(r.pago).toBe(false);
    expect(registro.update.pago_antecipado_em).toBeNull();
  });

  test('PDF: visão não lê, guarda e deixa a equipe conferir', async () => {
    const { supabase, registro } = criarSupabaseFalso(agendamentos);
    const groq = criarGroqFalso({});
    const evolution = { baixarMidiaBase64: jest.fn().mockResolvedValue({ base64: 'cGRm', mimetype: 'application/pdf' }) };
    const r = await processarComprovante({ ...base, mimetype: 'application/pdf', supabase, groq, evolution });

    expect(r).toMatchObject({ tratado: true, pago: false });
    expect(groq.chat.completions.create).not.toHaveBeenCalled();
    expect(registro.upload.caminho).toMatch(/\.pdf$/);
  });

  test('foto que não é comprovante: devolve pro fluxo normal, sem gravar nada', async () => {
    const { supabase, registro } = criarSupabaseFalso(agendamentos);
    const r = await processarComprovante({ ...base, supabase, groq: criarGroqFalso({ e_comprovante: false, valor: null }), evolution: evolutionComImagem });
    expect(r).toEqual({ tratado: false });
    expect(registro.update).toBeNull();
    expect(registro.upload).toBeNull();
  });

  test('cliente sem agendamento a pagar: devolve pro fluxo normal', async () => {
    const { supabase } = criarSupabaseFalso([]);
    const evolution = { baixarMidiaBase64: jest.fn() };
    const r = await processarComprovante({ ...base, supabase, groq: criarGroqFalso({}), evolution });
    expect(r).toEqual({ tratado: false });
    expect(evolution.baixarMidiaBase64).not.toHaveBeenCalled();
  });

  test('falha ao baixar a mídia: registra o recebimento, não marca pago', async () => {
    const { supabase, registro } = criarSupabaseFalso(agendamentos);
    const evolution = { baixarMidiaBase64: jest.fn().mockRejectedValue(new Error('404')) };
    const r = await processarComprovante({ ...base, supabase, groq: criarGroqFalso({}), evolution });
    expect(r).toMatchObject({ tratado: true, pago: false });
    expect(registro.update.comprovante_recebido_em).toBeTruthy();
    expect(registro.update.comprovante_path).toBeNull();
  });
});

describe('processarComprovante -- sinal de remarcação', () => {
  const remarcacao = [{ id: 'ag-corte', inicio: amanha.toISOString(), sinal_remarcacao_valor: 24, estabelecimento_atividades: { nome: 'Corte', preco: 80 } }];

  test('comprovante com valor >= sinal: marca o sinal pago (não o agendamento) e pede o novo horário', async () => {
    const { supabase, registro } = criarSupabaseFalso(agendamentos, { remarcacao });
    const r = await processarComprovante({ ...base, supabase, groq: criarGroqFalso({ e_comprovante: true, valor: 24 }), evolution: evolutionComImagem });

    expect(r).toMatchObject({ tratado: true, pago: true });
    expect(r.resposta).toMatch(/novo dia e horário/);
    expect(registro.idsAtualizados).toEqual(['ag-corte']);
    expect(registro.update.sinal_remarcacao_pago_em).toBeTruthy();
    expect(registro.update).not.toHaveProperty('pago_antecipado_em');
  });

  test('valor menor que o sinal: não libera a remarcação', async () => {
    const { supabase, registro } = criarSupabaseFalso(agendamentos, { remarcacao });
    const r = await processarComprovante({ ...base, supabase, groq: criarGroqFalso({ e_comprovante: true, valor: 10 }), evolution: evolutionComImagem });
    expect(r.pago).toBe(false);
    expect(registro.update.sinal_remarcacao_pago_em).toBeNull();
  });
});

describe('valorEsperado', () => {
  test('soma os preços', () => {
    expect(valorEsperado(agendamentos.slice(0, 2))).toBe(115);
  });
  test('serviço sem preço cadastrado: null (não dá pra comparar)', () => {
    expect(valorEsperado([{ estabelecimento_atividades: { preco: null } }])).toBeNull();
  });
});
