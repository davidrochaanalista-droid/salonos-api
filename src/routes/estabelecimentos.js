/**
 * SalonOS API — Rotas de Estabelecimentos
 * =========================================
 * Todas as queries usam req.supabase (cliente escopado ao token do
 * usuário — ver middleware/auth.js), então o RLS do Postgres já
 * garante que um proprietário só vê/edita os próprios estabelecimentos.
 */

const express = require('express');
const { encryptSensitive, decryptSensitive } = require('../lib/crypto');
const { gerarCopiaECola, gerarImagemQr } = require('../lib/pix');
const { adotarCatalogoCompleto } = require('./atividades');
const supabaseAdmin = require('../lib/supabaseAdmin');
const router = express.Router();

// Nunca devolvida em resposta de API nenhuma -- select() explícito em vez
// de '*' nas rotas de leitura, pra garantir que o blob cifrado de
// credencial de gateway nem trafega de volta pro navegador.
const COLUNAS_PUBLICAS = 'id, proprietario_id, login_user_id, segmento_id, nome, whatsapp, cnpj, cidade, bairro, endereco, cep, latitude, longitude, horario_abertura, horario_fechamento, dias_funcionamento, plano, status_assinatura, vencimento_em, chave_pix, gateway_pagamento, created_at';

// POST /estabelecimentos — cadastrar novo estabelecimento. Cria também o
// login PRÓPRIO do salão (email_salao/senha_salao, diferente do login do
// proprietário) -- ver database/35-login-salao.sql: sem isso, qualquer
// funcionário que opera o salon-v6.html com a senha do dono também abriria
// o painel-proprietario.html e veria margem/MRR de toda a rede. E já
// pré-cadastra o catálogo de serviços do segmento (mesma lógica de
// POST /estabelecimentos/:id/atividades/adotar-catalogo-completo), pra não
// nascer sem nenhum serviço agendável.
router.post('/', async (req, res) => {
  const { segmento_id, nome, whatsapp, cnpj, endereco, email_salao, senha_salao, horario_abertura, horario_fechamento, dias_funcionamento } = req.body;

  if (!segmento_id || !nome || !whatsapp || !email_salao || !senha_salao) {
    return res.status(400).json({ erro: 'segmento_id, nome, whatsapp, email_salao e senha_salao são obrigatórios.' });
  }

  // Busca o proprietario_id vinculado ao usuário logado (criado automaticamente
  // no signup pelo trigger criar_proprietario_no_signup — ver schema, seção 8)
  const { data: proprietario, error: errProp } = await req.supabase
    .from('proprietarios')
    .select('id')
    .eq('user_id', req.user.id)
    .single();

  if (errProp || !proprietario) {
    return res.status(404).json({ erro: 'Cadastro de proprietário não encontrado para este usuário.' });
  }

  const { data: novoUsuario, error: errUsuario } = await supabaseAdmin.auth.admin.createUser({
    email: email_salao,
    password: senha_salao,
    email_confirm: true, // o próprio dono está criando esse login agora, não precisa de confirmação por e-mail
    // tipo:'login_salao' faz criar_proprietario_no_signup() (database/36-
    // login-salao-sem-proprietario.sql) pular esse usuário -- sem isso o
    // login do salão ganhava uma linha em proprietarios e o bloqueio do
    // painel-proprietario.html não pegava.
    user_metadata: { tipo: 'login_salao' },
  });

  if (errUsuario) {
    const jaExiste = /already been registered|already exists/i.test(errUsuario.message);
    return res.status(jaExiste ? 409 : 500).json({ erro: jaExiste ? 'Já existe uma conta com esse e-mail de login do salão.' : errUsuario.message });
  }

  const { data, error } = await req.supabase
    .from('estabelecimentos')
    .insert({
      proprietario_id: proprietario.id,
      login_user_id: novoUsuario.user.id,
      segmento_id, nome, whatsapp, cnpj, endereco,
      horario_abertura, horario_fechamento, dias_funcionamento,
    })
    .select()
    .single();

  if (error) {
    // Não pode sobrar um login de salão órfão sem estabelecimento nenhum atrelado.
    await supabaseAdmin.auth.admin.deleteUser(novoUsuario.user.id);
    return res.status(500).json({ erro: error.message });
  }

  try {
    await adotarCatalogoCompleto(req.supabase, data.id, segmento_id);
  } catch (erroCatalogo) {
    req.log?.error(erroCatalogo, 'Falha ao pré-cadastrar catálogo do segmento no cadastro novo');
  }

  res.status(201).json(data);
});

// GET /estabelecimentos — lista os estabelecimentos do proprietário logado
router.get('/', async (req, res) => {
  const { data, error } = await req.supabase
    .from('estabelecimentos')
    .select(`${COLUNAS_PUBLICAS}, segmentos(nome, slug, icone)`)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// GET /estabelecimentos/:id — detalhe de um estabelecimento
router.get('/:id', async (req, res) => {
  const { data, error } = await req.supabase
    .from('estabelecimentos')
    .select(`${COLUNAS_PUBLICAS}, segmentos(nome, slug, icone)`)
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(404).json({ erro: 'Estabelecimento não encontrado ou sem permissão de acesso.' });
  res.json(data);
});

// PATCH /estabelecimentos/:id — editar dados do estabelecimento
// Nota: gateway_credenciais (objeto em texto plano, nunca a coluna
// cifrada diretamente) é encriptado aqui no servidor antes de gravar --
// o front nunca manda nem lê o blob cifrado, só o formulário. Como a API
// nunca devolve a credencial salva (por segurança), o formulário do
// painel não tem como saber o que já está configurado -- por isso o
// corpo carrega só os campos que o dono de fato preencheu, e aqui
// mesclamos em cima do que já existia em vez de substituir o blob
// inteiro (senão trocar só o access_token apagaria o webhook_secret
// salvo antes, por exemplo).
router.patch('/:id', async (req, res) => {
  const camposPermitidos = ['nome', 'whatsapp', 'cnpj', 'cidade', 'bairro', 'endereco', 'cep', 'horario_abertura', 'horario_fechamento', 'dias_funcionamento', 'plano', 'chave_pix', 'gateway_pagamento'];
  const atualizacoes = {};
  for (const campo of camposPermitidos) {
    if (req.body[campo] !== undefined) atualizacoes[campo] = req.body[campo];
  }
  if (req.body.gateway_credenciais !== undefined) {
    if (req.body.gateway_credenciais) {
      const { data: atual } = await req.supabase
        .from('estabelecimentos')
        .select('gateway_credenciais_criptografadas')
        .eq('id', req.params.id)
        .single();

      let credenciaisExistentes = {};
      if (atual?.gateway_credenciais_criptografadas) {
        try {
          credenciaisExistentes = JSON.parse(decryptSensitive(atual.gateway_credenciais_criptografadas));
        } catch (erro) {
          console.error(`Falha ao descriptografar credencial de gateway existente do estabelecimento ${req.params.id}:`, erro.message);
        }
      }

      const mesclado = { ...credenciaisExistentes };
      for (const [chave, valor] of Object.entries(req.body.gateway_credenciais)) {
        if (valor) mesclado[chave] = valor; // só sobrescreve o que o dono de fato preencheu
      }
      atualizacoes.gateway_credenciais_criptografadas = encryptSensitive(JSON.stringify(mesclado));
    } else {
      // dono escolheu "Nenhum" gateway -- limpa a credencial de propósito
      atualizacoes.gateway_credenciais_criptografadas = null;
    }
  }

  const { data, error } = await req.supabase
    .from('estabelecimentos')
    .update(atualizacoes)
    .eq('id', req.params.id)
    .select(COLUNAS_PUBLICAS)
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// GET /estabelecimentos/:id/pix — copia-e-cola + QR da chave Pix solta
// cadastrada (item 1A do plano -- sem valor, sem gateway). 404 se ainda
// não cadastrou nenhuma chave.
router.get('/:id/pix', async (req, res) => {
  const { data: estabelecimento, error } = await req.supabase
    .from('estabelecimentos')
    .select('nome, cidade, chave_pix')
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(404).json({ erro: 'Estabelecimento não encontrado ou sem permissão de acesso.' });
  if (!estabelecimento.chave_pix) return res.status(404).json({ erro: 'Nenhuma chave Pix cadastrada ainda.' });

  const args = { chavePix: estabelecimento.chave_pix, nomeEstabelecimento: estabelecimento.nome, cidade: estabelecimento.cidade };
  const copia_cola = gerarCopiaECola(args);
  if (!copia_cola) return res.status(500).json({ erro: 'Não foi possível gerar o Pix com essa chave cadastrada.' });

  const qr_data_url = await gerarImagemQr(args);
  res.json({ chave_pix: estabelecimento.chave_pix, copia_cola, qr_data_url });
});

module.exports = router;
