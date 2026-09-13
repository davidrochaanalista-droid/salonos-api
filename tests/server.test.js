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
});
