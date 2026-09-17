/**
 * Testes de conflito de horário e de resposta parcial a uma proposta de
 * agendamento via WhatsApp -- ver src/lib/agendamento-confirmacao.js e
 * src/routes/whatsapp.js (tratarRespostaPropostaHorario).
 *
 * Nenhum teste aqui bate na rede/Supabase/Groq de verdade (mesmo padrão
 * dos outros testes deste projeto, ver jest.setup.js) -- os clientes
 * Supabase e a Groq são substituídos por dublês que reproduzem
 * exatamente a forma da resposta real (fila de respostas por tabela,
 * na ordem em que o código sob teste efetivamente chama cada uma).
 */

// Fila de respostas por tabela: cada chamada a .from(tabela) consome o
// próximo item da fila daquela tabela, na ordem. O builder devolvido
// aceita tanto ser encadeado (select/eq/not/lt/gt/order/in/update/insert
// sempre devolvem o próprio builder) quanto ser aguardado em qualquer
// ponto da cadeia (.then), ou finalizado com .single()/.limit() --
// cobre os três jeitos que o código real usa a lib do Supabase.
function criarClienteFalso(respostasPorTabela) {
  const contadores = {};
  const from = jest.fn((tabela) => {
    const indice = contadores[tabela] || 0;
    const fila = respostasPorTabela[tabela] || [];
    const resultado = fila[indice] !== undefined ? fila[indice] : { data: null, error: null };
    contadores[tabela] = indice + 1;

    const builder = {};
    ['select', 'eq', 'neq', 'not', 'lt', 'gt', 'order', 'in', 'update', 'insert'].forEach((metodo) => {
      builder[metodo] = jest.fn(() => builder);
    });
    builder.single = jest.fn(() => Promise.resolve(resultado));
    builder.limit = jest.fn(() => Promise.resolve(resultado));
    builder.then = (resolve, reject) => Promise.resolve(resultado).then(resolve, reject);
    return builder;
  });
  return { from };
}

describe('Conflito de horário (confirmarSolicitacaoAgendamento)', () => {
  const { confirmarSolicitacaoAgendamento } = require('../src/lib/agendamento-confirmacao');

  it('recusa confirmar quando a profissional já tem atendimento no horário (conflito real)', async () => {
    const solicitacao = {
      id: 'sol-1',
      status: 'pendente',
      data_hora_proposta: null,
      data_hora_solicitada: '2026-10-01T13:00:00.000Z',
      profissional_id: 'prof-1',
      estabelecimento_atividades: { nome: 'Corte de Cabelo', duracao_min: 60 },
      profissionais: { nome: 'Camila' },
      clientes: { nome: 'Beatriz' },
    };
    const clienteFalso = criarClienteFalso({
      solicitacoes_agendamento: [{ data: solicitacao, error: null }],
      // buscarConflitoAgendamento -> .limit(1): encontra um agendamento existente no horário
      agendamentos: [{ data: [{ id: 'ag-existente', clientes: { nome: 'Outra Cliente' } }], error: null }],
    });

    const resultado = await confirmarSolicitacaoAgendamento(clienteFalso, { solicitacaoId: 'sol-1' });

    expect(resultado.ok).toBe(false);
    expect(resultado.conflito).toBe(true);
    expect(resultado.motivo).toContain('Camila');
    expect(resultado.motivo).toContain('Outra Cliente');
  });

  it('confirma e cria o agendamento quando não há conflito', async () => {
    const solicitacao = {
      id: 'sol-2',
      status: 'horario_proposto',
      data_hora_proposta: '2026-10-01T15:00:00.000Z',
      data_hora_solicitada: null,
      profissional_id: 'prof-1',
      estabelecimento_id: 'estab-1',
      cliente_id: 'cli-1',
      estabelecimento_atividade_id: 'ativ-1',
      estabelecimento_atividades: { nome: 'Manicure', duracao_min: 45 },
      profissionais: { nome: 'Camila' },
      clientes: { nome: 'Beatriz' },
    };
    const clienteFalso = criarClienteFalso({
      solicitacoes_agendamento: [
        { data: solicitacao, error: null }, // select
        { error: null }, // update -> status confirmado
      ],
      agendamentos: [
        { data: [], error: null }, // buscarConflitoAgendamento -> sem conflito
        { data: { id: 'ag-novo-1' }, error: null }, // insert do agendamento novo
      ],
    });

    const resultado = await confirmarSolicitacaoAgendamento(clienteFalso, { solicitacaoId: 'sol-2' });

    expect(resultado.ok).toBe(true);
    expect(resultado.agendamento).toEqual({ id: 'ag-novo-1' });
  });
});

describe('Resposta parcial a proposta de horário via WhatsApp (tratarRespostaPropostaHorario)', () => {
  // tratarRespostaPropostaHorario usa o client Supabase e a Groq do
  // ESCOPO DO MÓDULO (não recebe por parâmetro) -- só dá pra trocar por
  // um dublê mockando os módulos antes do require, com registro isolado
  // por teste (jest.resetModules + jest.doMock).
  beforeEach(() => {
    jest.resetModules();
  });

  function mockarGroqComResposta(argumentosFerramenta) {
    jest.doMock('groq-sdk', () => jest.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(argumentosFerramenta) } }] } }],
          }),
        },
      },
    })));
  }

  it('confirma só o serviço aceito e devolve o outro para pendente (aceitou parcial)', async () => {
    mockarGroqComResposta({ resposta: 'parcial', servicos_aceitos: ['Corte de Cabelo'], novo_pedido: '' });

    const solCorte = {
      id: 'sol-corte', status: 'horario_proposto', estabelecimento_id: 'estab-1', profissional_id: 'prof-1',
      data_hora_proposta: '2026-10-01T15:00:00.000Z', origem_proposta: 'equipe',
      estabelecimento_atividades: { nome: 'Corte de Cabelo', duracao_min: 60 },
      profissionais: { nome: 'Camila' }, clientes: { nome: 'Beatriz' },
    };
    const solManicure = {
      id: 'sol-manicure', status: 'horario_proposto', estabelecimento_id: 'estab-1', profissional_id: 'prof-2',
      data_hora_proposta: '2026-10-01T15:00:00.000Z', origem_proposta: 'equipe',
      estabelecimento_atividades: { nome: 'Manicure', duracao_min: 45 },
      profissionais: { nome: 'Renata' }, clientes: { nome: 'Beatriz' },
    };

    const clienteFalso = criarClienteFalso({
      // ACEITAS (Corte): confirmarSolicitacaoAgendamento -> select, buscarConflito, insert, update
      solicitacoes_agendamento: [
        { data: solCorte, error: null }, // select dentro de confirmarSolicitacaoAgendamento (aceitas)
        { error: null }, // update -> confirmado (aceitas)
        { error: null }, // update -> pendente (recusadas: Manicure)
      ],
      agendamentos: [
        { data: [], error: null }, // buscarConflitoAgendamento (Corte) -> sem conflito
        { data: { id: 'ag-corte' }, error: null }, // insert (Corte)
      ],
    });

    jest.doMock('@supabase/supabase-js', () => ({ createClient: () => clienteFalso }));
    const { tratarRespostaPropostaHorario } = require('../src/routes/whatsapp');

    const texto = await tratarRespostaPropostaHorario({
      solicitacoesPendentes: [solCorte, solManicure],
      mensagem: 'Quero só o corte de cabelo, pode cancelar a manicure',
      cliente: { nome: 'Beatriz', telefone: '11999990000' },
      estabelecimento: { horario_abertura: '09:00', horario_fechamento: '19:00', dias_funcionamento: ['seg', 'ter', 'qua', 'qui', 'sex', 'sab'] },
      estabelecimentoId: 'estab-1',
    });

    expect(texto).toContain('Corte de Cabelo');
    expect(texto.toLowerCase()).not.toContain('manicure');
    expect(clienteFalso.from).toHaveBeenCalledWith('agendamentos');
    expect(clienteFalso.from).toHaveBeenCalledWith('solicitacoes_agendamento');
  });

  it('nunca assume "recusou tudo" quando a Groq devolve parcial sem nenhum serviço listado (ambíguo)', async () => {
    mockarGroqComResposta({ resposta: 'parcial', servicos_aceitos: [], novo_pedido: '' });
    jest.doMock('@supabase/supabase-js', () => ({ createClient: () => criarClienteFalso({}) }));
    const { tratarRespostaPropostaHorario } = require('../src/routes/whatsapp');

    const solicitacao = {
      id: 'sol-x', estabelecimento_id: 'estab-1', profissional_id: 'prof-1',
      data_hora_proposta: '2026-10-01T15:00:00.000Z', origem_proposta: 'equipe',
      estabelecimento_atividades: { nome: 'Corte de Cabelo', duracao_min: 60 },
      profissionais: { nome: 'Camila' }, clientes: { nome: 'Beatriz' },
    };

    const texto = await tratarRespostaPropostaHorario({
      solicitacoesPendentes: [solicitacao],
      mensagem: 'hmm deixa eu ver',
      cliente: { nome: 'Beatriz', telefone: '11999990000' },
      estabelecimento: { horario_abertura: '09:00', horario_fechamento: '19:00', dias_funcionamento: ['seg'] },
      estabelecimentoId: 'estab-1',
    });

    // Nenhuma escrita no banco deve acontecer nesse caso ambíguo -- só a
    // resposta de "vou confirmar com a equipe" (ver comentário na função).
    expect(texto).toMatch(/equipe/i);
  });
});
