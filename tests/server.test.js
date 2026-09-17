const request = require('supertest');
const app = require('../src/server');

describe('GET /health', () => {
  it('responde 200 com status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('Autenticação', () => {
  it('bloqueia rota protegida sem Authorization header', async () => {
    const res = await request(app).get('/estabelecimentos');
    expect(res.status).toBe(401);
  });

  it('bloqueia rota protegida com header mal formado', async () => {
    const res = await request(app).get('/estabelecimentos').set('Authorization', 'token-sem-bearer');
    expect(res.status).toBe(401);
  });

  it('não exige autenticação no webhook do WhatsApp', async () => {
    const res = await request(app).post('/webhook/whatsapp/qualquer-id').send({});
    expect(res.status).not.toBe(401);
  });

  it('não exige autenticação em /avaliacoes (cliente sem login)', async () => {
    const res = await request(app).post('/avaliacoes').send({ atendimento_id: 'qualquer-id', nota: 5 });
    expect(res.status).not.toBe(401);
  });

  it('bloqueia /estabelecimentos/:id/metas sem Authorization header', async () => {
    const res = await request(app).get('/estabelecimentos/qualquer-id/metas');
    expect(res.status).toBe(401);
  });

  it('bloqueia /estabelecimentos/:id/automacoes sem Authorization header', async () => {
    const res = await request(app).get('/estabelecimentos/qualquer-id/automacoes');
    expect(res.status).toBe(401);
  });

  it('bloqueia /estabelecimentos/:id/lista-espera sem Authorization header', async () => {
    const res = await request(app).get('/estabelecimentos/qualquer-id/lista-espera');
    expect(res.status).toBe(401);
  });

  it('bloqueia /estabelecimentos/:id/produtos sem Authorization header', async () => {
    const res = await request(app).get('/estabelecimentos/qualquer-id/produtos');
    expect(res.status).toBe(401);
  });

  it('bloqueia /atividades/:id/receita sem Authorization header', async () => {
    const res = await request(app).get('/atividades/qualquer-id/receita');
    expect(res.status).toBe(401);
  });

  it('bloqueia /estabelecimentos/:id/whatsapp/status sem Authorization header', async () => {
    const res = await request(app).get('/estabelecimentos/qualquer-id/whatsapp/status');
    expect(res.status).toBe(401);
  });

  it('bloqueia /estabelecimentos/:id/whatsapp/contatos sem Authorization header', async () => {
    const res = await request(app).get('/estabelecimentos/qualquer-id/whatsapp/contatos');
    expect(res.status).toBe(401);
  });

  it('bloqueia /estabelecimentos/:id/solicitacoes-agendamento sem Authorization header', async () => {
    const res = await request(app).get('/estabelecimentos/qualquer-id/solicitacoes-agendamento');
    expect(res.status).toBe(401);
  });

  it('bloqueia /solicitacoes-agendamento/:id/aceitar sem Authorization header', async () => {
    const res = await request(app).post('/solicitacoes-agendamento/qualquer-id/aceitar');
    expect(res.status).toBe(401);
  });

  it('bloqueia DELETE /atividades/:id sem Authorization header', async () => {
    const res = await request(app).delete('/atividades/qualquer-id');
    expect(res.status).toBe(401);
  });

  it('bloqueia /produtos/:id/lotes sem Authorization header', async () => {
    const res = await request(app).get('/produtos/qualquer-id/lotes');
    expect(res.status).toBe(401);
  });

  it('bloqueia POST /produtos/:id/lotes sem Authorization header', async () => {
    const res = await request(app).post('/produtos/qualquer-id/lotes').send({ quantidade_inicial: 1 });
    expect(res.status).toBe(401);
  });

  it('bloqueia /lotes/:id sem Authorization header', async () => {
    const res = await request(app).patch('/lotes/qualquer-id').send({ quantidade_atual: 1 });
    expect(res.status).toBe(401);
  });

  it('bloqueia /estabelecimentos/:id/lotes-vencendo sem Authorization header', async () => {
    const res = await request(app).get('/estabelecimentos/qualquer-id/lotes-vencendo');
    expect(res.status).toBe(401);
  });

  it('bloqueia /admin/me sem Authorization header', async () => {
    const res = await request(app).get('/admin/me');
    expect(res.status).toBe(401);
  });

  it('bloqueia /admin/contas sem Authorization header', async () => {
    const res = await request(app).get('/admin/contas');
    expect(res.status).toBe(401);
  });

  it('bloqueia /admin/visao sem Authorization header', async () => {
    const res = await request(app).get('/admin/visao');
    expect(res.status).toBe(401);
  });

  it('bloqueia /solicitacoes-agendamento/grupo/:grupoId/aceitar sem Authorization header', async () => {
    const res = await request(app).post('/solicitacoes-agendamento/grupo/qualquer-id/aceitar');
    expect(res.status).toBe(401);
  });

  it('bloqueia GET /estabelecimentos/:id/pix sem Authorization header', async () => {
    const res = await request(app).get('/estabelecimentos/qualquer-id/pix');
    expect(res.status).toBe(401);
  });

  it('bloqueia POST /comandas/:id/cobrar-pix sem Authorization header', async () => {
    const res = await request(app).post('/comandas/qualquer-id/cobrar-pix');
    expect(res.status).toBe(401);
  });

  it('não exige autenticação no webhook de pagamento Pix (chamado pelo provedor)', async () => {
    // gateway inexistente propositalmente -- obterAdapter() rejeita e a rota
    // responde 404 antes de bater no Supabase (nenhum teste aqui bate na
    // rede de verdade, ver jest.setup.js). O que importa pro teste é que
    // NÃO seja 401: a rota está montada antes de `autenticar`.
    const res = await request(app).post('/webhooks/pix/gateway-inexistente/qualquer-id').send({});
    expect(res.status).not.toBe(401);
  });

  it('bloqueia POST /estabelecimentos/:id/tickets sem Authorization header', async () => {
    const res = await request(app).post('/estabelecimentos/qualquer-id/tickets').send({ assunto: 'x', mensagem: 'y' });
    expect(res.status).toBe(401);
  });

  it('bloqueia GET /estabelecimentos/:id/tickets sem Authorization header', async () => {
    const res = await request(app).get('/estabelecimentos/qualquer-id/tickets');
    expect(res.status).toBe(401);
  });

  it('bloqueia /admin/tickets sem Authorization header', async () => {
    const res = await request(app).get('/admin/tickets');
    expect(res.status).toBe(401);
  });

  it('bloqueia PATCH /admin/tickets/:id sem Authorization header', async () => {
    const res = await request(app).patch('/admin/tickets/qualquer-id').send({ status: 'resolvido' });
    expect(res.status).toBe(401);
  });

  it('bloqueia /admin/auditoria sem Authorization header', async () => {
    const res = await request(app).get('/admin/auditoria');
    expect(res.status).toBe(401);
  });

  it('bloqueia /admin/hub-metricas sem X-Hub-Key (não é rota de usuário logado)', async () => {
    const res = await request(app).get('/admin/hub-metricas');
    expect(res.status).toBe(401);
  });

  it('bloqueia /admin/hub-metricas com X-Hub-Key errada', async () => {
    const res = await request(app).get('/admin/hub-metricas').set('X-Hub-Key', 'chave-errada');
    expect(res.status).toBe(401);
  });

  it('bloqueia POST /admin/convites sem Authorization header', async () => {
    const res = await request(app).post('/admin/convites').send({ email: 'teste@exemplo.com' });
    expect(res.status).toBe(401);
  });

  it('bloqueia PATCH /admin/contas/:id sem Authorization header', async () => {
    const res = await request(app).patch('/admin/contas/qualquer-id').send({ status_assinatura: 'ativo' });
    expect(res.status).toBe(401);
  });

  it('bloqueia PATCH /proprietarios/me sem Authorization header', async () => {
    const res = await request(app).patch('/proprietarios/me').send({ nome: 'Teste' });
    expect(res.status).toBe(401);
  });

  it('bloqueia DELETE /produtos/:id sem Authorization header', async () => {
    const res = await request(app).delete('/produtos/qualquer-id');
    expect(res.status).toBe(401);
  });
});
