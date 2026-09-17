/**
 * SalonOS API — Rotas do painel administrativo interno
 * =========================================================
 * Todas as rotas aqui passam por `autenticar` + `exigirAdmin` (montado
 * em server.js) -- usam req.supabaseAdmin (service_role, cross-tenant
 * de propósito), nunca req.supabase. Ver src/middleware/exigirAdmin.js.
 *
 * Escopo desta entrega (15/09/2026): Contas, Visão Geral, Auditoria &
 * LGPD e Suporte já têm dado real por trás (auditoria_acessos e
 * tickets_suporte, ver database/26 e 27). Financeiro segue sem sistema
 * real (sem conciliação bancária própria da plataforma) -- fica "em
 * breve" no frontend, sem rota correspondente aqui, mesmo princípio já
 * usado no resto do projeto: nenhuma seção mostra número inventado.
 */

const express = require('express');
const router = express.Router();

// GET /admin/me — confirma pro frontend que o usuário logado é admin
router.get('/admin/me', (req, res) => {
  res.json({ admin: true });
});

// GET /admin/contas — lista todas as contas da plataforma
router.get('/admin/contas', async (req, res) => {
  const { data, error } = await req.supabaseAdmin
    .from('estabelecimentos')
    .select('id, nome, cidade, bairro, endereco, cep, cnpj, plano, status_assinatura, vencimento_em, created_at, proprietarios(nome, telefone, cpf)')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// PATCH /admin/contas/:id — David aprova (muda status_assinatura), deixa
// livre, ou troca o plano -- única forma de editar esses campos, o dono
// do salão nunca escolhe o próprio status/plano.
router.patch('/admin/contas/:id', async (req, res) => {
  const { status_assinatura, plano, vencimento_em } = req.body;
  const atualizacoes = {};
  if (status_assinatura !== undefined) atualizacoes.status_assinatura = status_assinatura;
  if (plano !== undefined) atualizacoes.plano = plano;
  if (vencimento_em !== undefined) {
    atualizacoes.vencimento_em = vencimento_em || null;
    // Data mudou -- reseta o controle de limiar já avisado (7/3/1/0 dias)
    // pra avisar de novo do zero contando a partir da data nova.
    atualizacoes.vencimento_lembrete_enviado_dias = null;
  }

  // "Livre" é cortesia com acesso total (nível do plano "escala"),
  // sem cobrar nada -- garante essa consistência mesmo que o admin
  // tenha mandado outro plano junto sem querer.
  if (atualizacoes.status_assinatura === 'livre') atualizacoes.plano = 'escala';

  const { data, error } = await req.supabaseAdmin
    .from('estabelecimentos')
    .update(atualizacoes)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// POST /admin/convites — manda o link de acesso pro futuro dono do
// salão (Supabase Auth invite nativo) -- é assim que alguém vira
// proprietário no SalonOS agora; não existe mais auto-cadastro aberto
// (ver public/cadastro-real.html e a pendência de desligar "Allow new
// users to sign up" no Supabase Dashboard, documentada no CLAUDE.md).
router.post('/admin/convites', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ erro: 'email é obrigatório.' });

  const { error } = await req.supabaseAdmin.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${process.env.PUBLIC_BASE_URL}/cadastro-real.html`,
  });

  if (error) return res.status(500).json({ erro: error.message });
  res.json({ ok: true });
});

// GET /admin/visao — contagens por status + MRR contratado somado
router.get('/admin/visao', async (req, res) => {
  const [{ data: estabelecimentos, error: errEst }, { data: precos, error: errPrecos }] = await Promise.all([
    req.supabaseAdmin.from('estabelecimentos').select('status_assinatura, plano'),
    req.supabaseAdmin.from('planos_precos').select('plano, valor_mensal'),
  ]);
  if (errEst) return res.status(500).json({ erro: errEst.message });
  if (errPrecos) return res.status(500).json({ erro: errPrecos.message });

  const valorPorPlano = Object.fromEntries(precos.map((p) => [p.plano, Number(p.valor_mensal)]));

  const contagemPorStatus = { trial: 0, ativo: 0, inadimplente: 0, cancelado: 0, livre: 0 };
  let mrrContratado = 0;
  for (const e of estabelecimentos) {
    if (contagemPorStatus[e.status_assinatura] !== undefined) contagemPorStatus[e.status_assinatura] += 1;
    if (e.status_assinatura === 'ativo') mrrContratado += valorPorPlano[e.plano] || 0;
  }

  res.json({
    total_contas: estabelecimentos.length,
    contagem_por_status: contagemPorStatus,
    mrr_contratado: mrrContratado,
  });
});

// GET /admin/auditoria?estabelecimento_id=&limit= — log de acesso a dado
// sensível de cliente (LGPD), cross-tenant por desenho -- só admin vê.
router.get('/admin/auditoria', async (req, res) => {
  const { estabelecimento_id, limit } = req.query;
  let consulta = req.supabaseAdmin
    .from('auditoria_acessos')
    .select('id, estabelecimento_id, ator, operacao, tabela, registro_id, detalhe, created_at')
    .order('created_at', { ascending: false })
    .limit(Math.min(Number(limit) || 200, 1000));

  if (estabelecimento_id) consulta = consulta.eq('estabelecimento_id', estabelecimento_id);

  const { data, error } = await consulta;
  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// GET /admin/tickets — todos os chamados de suporte, cross-tenant
router.get('/admin/tickets', async (req, res) => {
  const { status } = req.query;
  let consulta = req.supabaseAdmin
    .from('tickets_suporte')
    .select('id, estabelecimento_id, proprietario_id, assunto, mensagem, prioridade, status, resposta_admin, created_at, respondido_em, estabelecimentos(nome)')
    .order('created_at', { ascending: false });

  if (status) consulta = consulta.eq('status', status);

  const { data, error } = await consulta;
  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// PATCH /admin/tickets/:id — David responde/atualiza o status do chamado
router.patch('/admin/tickets/:id', async (req, res) => {
  const { resposta_admin, status } = req.body;
  const atualizacoes = {};
  if (resposta_admin !== undefined) {
    atualizacoes.resposta_admin = resposta_admin;
    atualizacoes.respondido_em = new Date().toISOString();
  }
  if (status !== undefined) atualizacoes.status = status;

  const { data, error } = await req.supabaseAdmin
    .from('tickets_suporte')
    .update(atualizacoes)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

module.exports = router;
