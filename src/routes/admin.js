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
const { adotarCatalogoCompleto } = require('./atividades');
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
//
// Também devolve o link em si (não só "enviado") -- pedido do David:
// quando o cliente não está com notebook/celular na hora, ele mesmo
// preenche o cadastro usando esse link, sem depender do e-mail chegar.
// inviteUserByEmail não devolve o link na resposta (só cria o usuário e
// manda o e-mail), então geramos um segundo link tipo 'recovery' pro
// mesmo e-mail logo em seguida -- funciona porque o usuário já existe
// nesse ponto (criado pelo invite acima), e cadastro-real.html trata
// type=recovery igual a type=invite na tela "defina sua senha" (ver
// VEIO_DE_CONVITE em cadastro-real.html).
router.post('/admin/convites', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ erro: 'email é obrigatório.' });

  const redirectTo = `${process.env.PUBLIC_BASE_URL}/cadastro-real.html`;

  const { error: errConvite } = await req.supabaseAdmin.auth.admin.inviteUserByEmail(email, { redirectTo });
  // "Já convidado antes" não é erro aqui -- David volta na mesma tela de
  // Convites Pendentes pra pegar um link novo (o antigo pode ter
  // expirado), então re-gerar pro mesmo e-mail precisa funcionar sem
  // travar. Qualquer outro erro de verdade (e-mail inválido, etc.) segue
  // bloqueando.
  if (errConvite && !/already been registered|already exists/i.test(errConvite.message)) {
    return res.status(500).json({ erro: errConvite.message });
  }

  const { data, error: errLink } = await req.supabaseAdmin.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo } });
  if (errLink) return res.status(500).json({ erro: errLink.message });

  res.json({ ok: true, link: data.properties.action_link });
});

// GET /admin/convites-pendentes — proprietários criados por convite que
// ainda não completaram a tela 1 (nome continua '', só o trigger
// criar_proprietario_no_signup gravou a linha) -- fica aqui, persistente,
// pro David poder voltar e re-gerar o link quando precisar (ver POST
// /admin/convites acima), em vez do link só existir uma vez no modal
// logo depois de gerado.
router.get('/admin/convites-pendentes', async (req, res) => {
  const { data: pendentes, error } = await req.supabaseAdmin
    .from('proprietarios')
    .select('id, user_id, created_at')
    .eq('nome', '')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ erro: error.message });

  const comEmail = await Promise.all(pendentes.map(async (p) => {
    const { data } = await req.supabaseAdmin.auth.admin.getUserById(p.user_id);
    return { id: p.id, email: data?.user?.email || '(e-mail não encontrado)', created_at: p.created_at };
  }));

  res.json(comEmail);
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

// POST /admin/cadastro-rapido — David cadastra o proprietário E o
// estabelecimento de uma vez só, sem convite nem link nenhum -- pedido
// dele: velocidade pra cadastrar cliente na hora (ex: presencialmente,
// sem o cliente precisar abrir nada depois). Cria os DOIS logins (dono +
// salão, mesmo modelo de database/35-login-salao.sql) e pré-cadastra o
// catálogo do segmento, exatamente como POST /estabelecimentos faz --
// só que aqui os dois passos (completar proprietário + criar
// estabelecimento) acontecem num request só, com req.supabaseAdmin
// (não dá pra usar req.supabase escopado ao David, já que o proprietário
// novo não é ele).
router.post('/admin/cadastro-rapido', async (req, res) => {
  const {
    email, senha, nome, telefone, cpf, genero,
    nome_estabelecimento, segmento_id, cnpj, whatsapp, endereco, email_salao, senha_salao,
  } = req.body;

  if (!email || !senha || !nome || !telefone || !nome_estabelecimento || !segmento_id || !whatsapp || !email_salao || !senha_salao) {
    return res.status(400).json({ erro: 'email, senha, nome, telefone, nome_estabelecimento, segmento_id, whatsapp, email_salao e senha_salao são obrigatórios.' });
  }

  const { data: novoProprietario, error: errProp } = await req.supabaseAdmin.auth.admin.createUser({
    email, password: senha, email_confirm: true,
    user_metadata: { nome, telefone, genero: genero || undefined },
  });
  if (errProp) {
    const jaExiste = /already been registered|already exists/i.test(errProp.message);
    return res.status(jaExiste ? 409 : 500).json({ erro: jaExiste ? 'Já existe uma conta com esse e-mail de proprietário.' : errProp.message });
  }

  if (cpf) {
    await req.supabaseAdmin.from('proprietarios').update({ cpf }).eq('user_id', novoProprietario.user.id);
  }

  const { data: proprietarioRow, error: errBusca } = await req.supabaseAdmin
    .from('proprietarios').select('id').eq('user_id', novoProprietario.user.id).single();
  if (errBusca || !proprietarioRow) {
    await req.supabaseAdmin.auth.admin.deleteUser(novoProprietario.user.id);
    return res.status(500).json({ erro: 'Falha ao localizar o cadastro de proprietário recém-criado.' });
  }

  const { data: novoLoginSalao, error: errUsuarioSalao } = await req.supabaseAdmin.auth.admin.createUser({
    email: email_salao, password: senha_salao, email_confirm: true,
    user_metadata: { tipo: 'login_salao' },
  });
  if (errUsuarioSalao) {
    await req.supabaseAdmin.auth.admin.deleteUser(novoProprietario.user.id);
    const jaExiste = /already been registered|already exists/i.test(errUsuarioSalao.message);
    return res.status(jaExiste ? 409 : 500).json({ erro: jaExiste ? 'Já existe uma conta com esse e-mail de login do salão.' : errUsuarioSalao.message });
  }

  const { data: estabelecimento, error: errEst } = await req.supabaseAdmin
    .from('estabelecimentos')
    .insert({
      proprietario_id: proprietarioRow.id,
      login_user_id: novoLoginSalao.user.id,
      segmento_id, nome: nome_estabelecimento, whatsapp, cnpj, endereco,
    })
    .select()
    .single();

  if (errEst) {
    await req.supabaseAdmin.auth.admin.deleteUser(novoLoginSalao.user.id);
    await req.supabaseAdmin.auth.admin.deleteUser(novoProprietario.user.id);
    return res.status(500).json({ erro: errEst.message });
  }

  try {
    await adotarCatalogoCompleto(req.supabaseAdmin, estabelecimento.id, segmento_id);
  } catch (erroCatalogo) {
    req.log?.error(erroCatalogo, 'Falha ao pré-cadastrar catálogo no cadastro rápido');
  }

  res.status(201).json({ proprietario_email: email, estabelecimento });
});

module.exports = router;
