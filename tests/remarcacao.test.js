/**
 * Remarcação pelo WhatsApp com sinal, sem aprovação da equipe
 * (src/lib/remarcacao.js). Supabase é dublê; conflito/alternativas de
 * agenda (src/lib/disponibilidade.js) são mockados.
 */

jest.mock('../src/lib/disponibilidade', () => ({
  ...jest.requireActual('../src/lib/disponibilidade'),
  buscarConflitoAgendamento: jest.fn(),
  buscarHorariosDisponiveis: jest.fn(),
}));

const { buscarConflitoAgendamento, buscarHorariosDisponiveis } = require('../src/lib/disponibilidade');
const { solicitarRemarcacao, remarcarAgendamento, interpretarDataHoraBrasilia } = require('../src/lib/remarcacao');

// Dublê: .maybeSingle()/.single() devolvem por tabela; update registrado.
function criarSupabaseFalso({ agendamento, estabelecimento }) {
  const registro = { update: null, idAtualizado: null };
  const supabase = {
    from: jest.fn((tabela) => {
      const builder = {};
      ['select', 'eq', 'in', 'is', 'gte'].forEach(m => { builder[m] = jest.fn(() => builder); });
      builder.maybeSingle = jest.fn(() => Promise.resolve({ data: tabela === 'agendamentos' ? agendamento : null, error: null }));
      builder.single = jest.fn(() => Promise.resolve({ data: tabela === 'estabelecimentos' ? estabelecimento : null, error: null }));
      builder.update = jest.fn((valores) => {
        registro.update = valores;
        return { eq: jest.fn((coluna, id) => { registro.idAtualizado = id; return Promise.resolve({ error: null }); }) };
      });
      return builder;
    }),
  };
  return { supabase, registro };
}

// Próxima segunda-feira às 10h (Brasília), sempre no futuro.
function proximaSegunda(hora) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  const ymd = d.toISOString().slice(0, 10);
  return `${ymd}T${hora}:00`;
}

const inicioAtual = new Date(Date.now() + 2 * 24 * 3600e3);
const agendamentoBase = {
  id: 'ag-1', status: 'confirmado', profissional_id: 'prof-1', estabelecimento_atividade_id: 'ativ-1',
  inicio: inicioAtual.toISOString(), fim: new Date(inicioAtual.getTime() + 60 * 60e3).toISOString(),
  sinal_remarcacao_valor: 24, sinal_remarcacao_pago_em: null,
  estabelecimento_atividades: { nome: 'Corte Feminino', preco: 80 },
};
const estabelecimento = { horario_abertura: '09:00:00', horario_fechamento: '19:00:00', dias_funcionamento: ['seg', 'ter', 'qua', 'qui', 'sex', 'sab'] };
const ids = { estabelecimentoId: 'est-1', clienteId: 'cli-1', agendamentoId: 'ag-1' };

beforeEach(() => {
  buscarConflitoAgendamento.mockReset().mockResolvedValue(null);
  buscarHorariosDisponiveis.mockReset().mockResolvedValue([]);
});

describe('solicitarRemarcacao', () => {
  test('grava o sinal pedido e devolve o valor em reais (sem porcentagem)', async () => {
    const { supabase, registro } = criarSupabaseFalso({ agendamento: agendamentoBase });
    const r = await solicitarRemarcacao(supabase, ids);
    expect(r).toMatchObject({ ok: true, sinal_ja_pago: false, valor_sinal: 'R$ 24,00' });
    expect(JSON.stringify(r)).not.toMatch(/%/);
    expect(registro.update.sinal_remarcacao_valor).toBe(24);
  });

  test('agendamento de outro cliente/salão (não encontrado): recusa', async () => {
    const { supabase } = criarSupabaseFalso({ agendamento: null });
    expect(await solicitarRemarcacao(supabase, ids)).toMatchObject({ ok: false });
  });
});

describe('remarcarAgendamento', () => {
  test('sem sinal pago: nunca remarca', async () => {
    const { supabase, registro } = criarSupabaseFalso({ agendamento: agendamentoBase, estabelecimento });
    const r = await remarcarAgendamento(supabase, { ...ids, novaDataHora: proximaSegunda('10:00') });
    expect(r.ok).toBe(false);
    expect(r.motivo).toMatch(/sinal/);
    expect(registro.update).toBeNull();
  });

  const comSinalPago = { ...agendamentoBase, sinal_remarcacao_pago_em: new Date().toISOString() };

  test('sinal pago e horário livre: move o PRÓPRIO agendamento, mantendo a duração', async () => {
    const { supabase, registro } = criarSupabaseFalso({ agendamento: comSinalPago, estabelecimento });
    const r = await remarcarAgendamento(supabase, { ...ids, novaDataHora: proximaSegunda('10:00') });

    expect(r).toMatchObject({ ok: true, remarcado: true });
    expect(registro.idAtualizado).toBe('ag-1');
    const novoInicio = new Date(registro.update.inicio);
    expect(novoInicio.toISOString()).toBe(interpretarDataHoraBrasilia(proximaSegunda('10:00')).toISOString());
    expect(new Date(registro.update.fim) - novoInicio).toBe(60 * 60e3);
    expect(registro.update.remarcado_em).toBeTruthy();
    expect(buscarConflitoAgendamento).toHaveBeenCalledWith(supabase, expect.objectContaining({ ignorarAgendamentoId: 'ag-1', profissionalId: 'prof-1' }));
  });

  test('horário ocupado: não muda nada e devolve alternativas livres', async () => {
    buscarConflitoAgendamento.mockResolvedValue({ id: 'outro' });
    buscarHorariosDisponiveis.mockResolvedValue([{ data: 'x', itens: [{ profissional_id: 'prof-1', inicio: '2030-01-07T14:00:00.000Z', fim: '2030-01-07T15:00:00.000Z' }] }]);
    const { supabase, registro } = criarSupabaseFalso({ agendamento: comSinalPago, estabelecimento });
    const r = await remarcarAgendamento(supabase, { ...ids, novaDataHora: proximaSegunda('10:00'), profissionaisAtivos: [{ id: 'prof-1', nome: 'Camila' }] });

    expect(r.ok).toBe(false);
    expect(registro.update).toBeNull();
    expect(r.alternativas_livres).toEqual([expect.objectContaining({ nova_data_hora: '2030-01-07T11:00:00', profissional: 'Camila' })]);
  });

  test('fora do horário de funcionamento: não muda nada', async () => {
    const { supabase, registro } = criarSupabaseFalso({ agendamento: comSinalPago, estabelecimento });
    const r = await remarcarAgendamento(supabase, { ...ids, novaDataHora: proximaSegunda('18:30') }); // termina 19:30, fecha 19:00
    expect(r.ok).toBe(false);
    expect(r.motivo).toMatch(/funcionamento/);
    expect(registro.update).toBeNull();
  });

  test('profissional_id que não é do salão é ignorado (mantém o original)', async () => {
    const { supabase, registro } = criarSupabaseFalso({ agendamento: comSinalPago, estabelecimento });
    await remarcarAgendamento(supabase, { ...ids, novaDataHora: proximaSegunda('10:00'), profissionalId: 'intruso', profissionaisAtivos: [{ id: 'prof-1' }] });
    expect(registro.update.profissional_id).toBe('prof-1');
  });
});

describe('interpretarDataHoraBrasilia', () => {
  test('sem fuso assume -03:00', () => {
    expect(interpretarDataHoraBrasilia('2030-01-07T10:00:00').toISOString()).toBe('2030-01-07T13:00:00.000Z');
    expect(interpretarDataHoraBrasilia('2030-01-07T10:00').toISOString()).toBe('2030-01-07T13:00:00.000Z');
  });
  test('inválida: null', () => {
    expect(interpretarDataHoraBrasilia('amanhã')).toBeNull();
  });
});
