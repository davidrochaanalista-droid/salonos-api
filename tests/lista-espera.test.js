/**
 * Lista de espera em cascata pelo WhatsApp (src/lib/lista-espera.js,
 * database/40-lista-espera-cascata.sql). Usa um banco em memória mínimo
 * (só os filtros que o código usa) pra acompanhar a cascata de ponta a
 * ponta: oferta -> recusa/expira -> próximo -> aceita -> agendado.
 */

const lista = require('../src/lib/lista-espera');

function criarBanco(tabelas, padroes = {}) {
  let seq = 0;
  const from = (tabela) => {
    const filtros = [];
    let op = 'select', payload = null, ordem = null, limite = null;
    const b = {
      select: () => b,
      eq: (c, v) => { filtros.push(r => r[c] === v); return b; },
      neq: (c, v) => { filtros.push(r => r[c] !== v); return b; },
      is: (c, v) => { filtros.push(r => (r[c] ?? null) === v); return b; },
      gt: (c, v) => { filtros.push(r => r[c] > v); return b; },
      gte: (c, v) => { filtros.push(r => r[c] >= v); return b; },
      lt: (c, v) => { filtros.push(r => r[c] < v); return b; },
      lte: (c, v) => { filtros.push(r => r[c] <= v); return b; },
      in: (c, vs) => { filtros.push(r => vs.includes(r[c])); return b; },
      not: (c, o, v) => {
        const vs = String(v).replace(/[()]/g, '').split(',');
        filtros.push(r => o === 'in' ? !vs.includes(r[c]) : (r[c] ?? null) !== v);
        return b;
      },
      order: (c, { ascending = true } = {}) => { ordem = { c, ascending }; return b; },
      limit: (n) => { limite = n; return b; },
      insert: (p) => { op = 'insert'; payload = p; return b; },
      update: (p) => { op = 'update'; payload = p; return b; },
      maybeSingle: () => executar().then(r => ({ data: r.data[0] ?? null, error: null })),
      single: () => executar().then(r => ({ data: r.data[0] ?? null, error: null })),
      then: (ok, erro) => executar().then(ok, erro),
    };
    function executar() {
      const linhas = tabelas[tabela] || (tabelas[tabela] = []);
      if (op === 'insert') {
        const novas = (Array.isArray(payload) ? payload : [payload])
          .map(p => ({ id: `${tabela}-${++seq}`, created_at: new Date(Date.now() + seq).toISOString(), ...(padroes[tabela] || {}), ...p }));
        linhas.push(...novas);
        return Promise.resolve({ data: novas, error: null });
      }
      let sel = linhas.filter(r => filtros.every(f => f(r)));
      if (op === 'update') { sel.forEach(r => Object.assign(r, payload)); return Promise.resolve({ data: sel, error: null }); }
      if (ordem) sel = [...sel].sort((a, x) => (a[ordem.c] > x[ordem.c] ? 1 : -1) * (ordem.ascending ? 1 : -1));
      if (limite != null) sel = sel.slice(0, limite);
      return Promise.resolve({ data: sel, error: null });
    }
    return b;
  };
  return { from, tabelas };
}

const emHoras = (h) => new Date(Date.now() + h * 3600e3).toISOString();

function montarCenario({ automacaoAtiva = true } = {}) {
  const cliente = (id, nome, telefone) => ({ id, nome, telefone });
  const fila = (id, clienteId, nome, telefone, minutosAtras, extra = {}) => ({
    id, estabelecimento_id: 'est', cliente_id: clienteId, estabelecimento_atividade_id: 'corte',
    profissional_id: null, atendido_em: null, created_at: emHoras(-minutosAtras / 60),
    clientes: cliente(clienteId, nome, telefone), estabelecimento_atividades: { nome: 'Corte' }, ...extra,
  });
  const banco = criarBanco({
    automacoes: [{ id: 'auto', estabelecimento_id: 'est', tipo: 'lista_espera', ativa: automacaoAtiva }],
    lista_espera: [
      fila('le-ana', 'ana', 'Ana Lima', '1100000001', 300),
      fila('le-bia', 'bia', 'Bia Rocha', '1100000002', 200),
      fila('le-carla', 'carla', 'Carla Dias', '1100000003', 100, { profissional_id: 'outra-prof' }), // prefere outra profissional
      fila('le-dani', 'dani', 'Dani Melo', '1100000004', 50),
    ],
    agendamentos: [],
    ofertas_horario_vago: [],
    automacao_disparos: [],
  }, { ofertas_horario_vago: { status: 'pendente', enviada_em: new Date().toISOString() } });
  const enviadas = [];
  const enviar = jest.fn(async (m) => { enviadas.push(m); });
  const vagaCancelada = {
    estabelecimento_id: 'est', cliente_id: 'quem-cancelou', estabelecimento_atividade_id: 'corte',
    profissional_id: 'camila', inicio: emHoras(24), fim: emHoras(25),
  };
  return { banco, supabase: banco, enviar, enviadas, vagaCancelada };
}

const groqQueResponde = (resposta) => ({ chat: { completions: { create: jest.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ resposta }) } }] }) } } });

describe('cascata da lista de espera', () => {
  test('vaga liberada vai pro 1º da fila, com mensagem de oferta', async () => {
    const c = montarCenario();
    const oferta = await lista.liberarVaga({ supabase: c.supabase, enviar: c.enviar, agendamento: c.vagaCancelada });

    expect(oferta.cliente_id).toBe('ana');
    expect(c.enviadas).toHaveLength(1);
    expect(c.enviadas[0].telefone).toBe('1100000001');
    expect(c.enviadas[0].texto).toMatch(/abriu um horário pra Corte/);
    expect(c.enviadas[0].texto).toMatch(/Quer que eu reserve/);
    expect(new Date(oferta.expira_em) - Date.now()).toBeGreaterThan(14 * 60e3);
    expect(c.banco.tabelas.automacao_disparos).toHaveLength(1);
  });

  test('recusou -> vai pro próximo; pula quem prefere outra profissional; aceitou -> agenda sozinho e sai da fila', async () => {
    const c = montarCenario();
    const ofertaAna = await lista.liberarVaga({ supabase: c.supabase, enviar: c.enviar, agendamento: c.vagaCancelada });

    const recusa = await lista.tratarRespostaOferta({
      supabase: c.supabase, groq: groqQueResponde('recusa'), enviar: c.enviar,
      oferta: { ...ofertaAna, estabelecimento_atividades: { nome: 'Corte' } }, mensagem: 'dessa vez não dá', cliente: { nome: 'Ana Lima' },
    });
    expect(recusa.tratado).toBe(true);
    expect(recusa.resposta).toMatch(/continua na nossa lista/);
    await new Promise(r => setImmediate(r)); // oferecerProximo roda em segundo plano

    expect(c.enviadas.map(m => m.telefone)).toEqual(['1100000001', '1100000002']); // Ana, depois Bia
    const ofertaBia = c.banco.tabelas.ofertas_horario_vago.find(o => o.cliente_id === 'bia');

    const aceite = await lista.tratarRespostaOferta({
      supabase: c.supabase, groq: groqQueResponde('aceita'), enviar: c.enviar,
      oferta: { ...ofertaBia, estabelecimento_atividades: { nome: 'Corte' } }, mensagem: 'quero sim!', cliente: { nome: 'Bia Rocha' },
      textoExtraConfirmacao: 'oferta de Pix',
    });
    expect(aceite.resposta).toMatch(/ficou confirmado/);
    expect(aceite.resposta).toMatch(/oferta de Pix/);
    expect(c.banco.tabelas.agendamentos).toEqual([expect.objectContaining({
      cliente_id: 'bia', profissional_id: 'camila', inicio: c.vagaCancelada.inicio, status: 'confirmado', origem: 'whatsapp',
    })]);
    expect(c.banco.tabelas.lista_espera.find(l => l.id === 'le-bia').atendido_em).toBeTruthy();
    expect(c.banco.tabelas.lista_espera.find(l => l.id === 'le-ana').atendido_em).toBeNull(); // recusou, continua na fila
  });

  test('sem resposta em 15 min: expira e oferece pro próximo', async () => {
    const c = montarCenario();
    const ofertaAna = await lista.liberarVaga({ supabase: c.supabase, enviar: c.enviar, agendamento: c.vagaCancelada });
    ofertaAna.expira_em = emHoras(-0.01); // venceu

    await lista.expirarOfertas({ supabase: c.supabase, enviar: c.enviar });

    expect(c.banco.tabelas.ofertas_horario_vago.find(o => o.cliente_id === 'ana').status).toBe('expirada');
    expect(c.enviadas.map(m => m.telefone)).toEqual(['1100000001', '1100000002']);
  });

  test('aceitou mas alguém ocupou o horário no meio: não agenda por cima', async () => {
    const c = montarCenario();
    const ofertaAna = await lista.liberarVaga({ supabase: c.supabase, enviar: c.enviar, agendamento: c.vagaCancelada });
    c.banco.tabelas.agendamentos.push({ id: 'painel', profissional_id: 'camila', status: 'confirmado', inicio: c.vagaCancelada.inicio, fim: c.vagaCancelada.fim });

    const r = await lista.tratarRespostaOferta({
      supabase: c.supabase, groq: groqQueResponde('aceita'), enviar: c.enviar,
      oferta: { ...ofertaAna, estabelecimento_atividades: { nome: 'Corte' } }, mensagem: 'sim', cliente: { nome: 'Ana' },
    });
    expect(r.resposta).toMatch(/acabou de ser preenchido/);
    expect(c.banco.tabelas.agendamentos).toHaveLength(1); // só o do painel
  });

  test('quem liberou a vaga nunca recebe a oferta dela', async () => {
    const c = montarCenario();
    const oferta = await lista.liberarVaga({ supabase: c.supabase, enviar: c.enviar, agendamento: { ...c.vagaCancelada, cliente_id: 'ana' } });
    expect(oferta.cliente_id).toBe('bia');
  });

  test('resposta que não é sim/não (dúvida): não mexe na oferta, segue pra IA', async () => {
    const c = montarCenario();
    const ofertaAna = await lista.liberarVaga({ supabase: c.supabase, enviar: c.enviar, agendamento: c.vagaCancelada });
    const r = await lista.tratarRespostaOferta({
      supabase: c.supabase, groq: groqQueResponde('outro'), enviar: c.enviar,
      oferta: ofertaAna, mensagem: 'qual o valor do corte?', cliente: { nome: 'Ana' },
    });
    expect(r).toEqual({ tratado: false });
    expect(c.banco.tabelas.ofertas_horario_vago[0].status).toBe('pendente');
  });

  test('automação desligada: não oferece nada', async () => {
    const c = montarCenario({ automacaoAtiva: false });
    expect(await lista.liberarVaga({ supabase: c.supabase, enviar: c.enviar, agendamento: c.vagaCancelada })).toBeNull();
    expect(c.enviar).not.toHaveBeenCalled();
  });

  test('vaga em cima da hora (menos de 20 min): não oferece', async () => {
    const c = montarCenario();
    const r = await lista.liberarVaga({ supabase: c.supabase, enviar: c.enviar, agendamento: { ...c.vagaCancelada, inicio: emHoras(0.2), fim: emHoras(1.2) } });
    expect(r).toBeNull();
  });
});

describe('entrarNaListaEspera (ferramenta da IA)', () => {
  test('entra na fila e não duplica', async () => {
    const c = montarCenario();
    const args = { estabelecimentoId: 'est', clienteId: 'nova', atividade: { id: 'corte' }, preferencia: 'sábado de manhã' };
    expect(await lista.entrarNaListaEspera(c.supabase, args)).toMatchObject({ ok: true, entrou_na_fila: true });
    expect(await lista.entrarNaListaEspera(c.supabase, args)).toMatchObject({ ok: true, ja_estava_na_fila: true });
    expect(c.banco.tabelas.lista_espera.filter(l => l.cliente_id === 'nova')).toEqual([expect.objectContaining({ origem: 'whatsapp', observacao: 'sábado de manhã' })]);
  });

  test('automação desligada: avisa a IA pra não oferecer lista', async () => {
    const c = montarCenario({ automacaoAtiva: false });
    const r = await lista.entrarNaListaEspera(c.supabase, { estabelecimentoId: 'est', clienteId: 'nova', atividade: { id: 'corte' } });
    expect(r.ok).toBe(false);
  });
});
