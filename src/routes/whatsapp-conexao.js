/**
 * SalonOS API — Conexão de WhatsApp por salão + importação de contatos
 * =======================================================================
 * Escopo fechado em 13/09/2026 (ver CLAUDE.md). Cada estabelecimento tem
 * sua própria instância no Evolution API (src/lib/evolution-api.js) --
 * essas rotas só orquestram: criar/parear via QR, consultar status
 * (lido do banco, sincronizado pelo webhook em routes/whatsapp.js -- ver
 * evento "connection.update"), e importar contatos salvos no celular
 * como clientes, sob revisão manual do dono (nunca automático).
 *
 * Evolution API deployada em produção (Railway, 13/09/2026) -- endpoints
 * usados aqui confirmados contra a instância real (ver evolution-api.js).
 * Falta só testar o pareamento de QR de ponta a ponta com um celular real.
 */

const express = require('express');
const evolution = require('../lib/evolution-api');
const { registrarAcessoAuditoria } = require('../lib/auditoria');

const router = express.Router();

// POST /estabelecimentos/:id/whatsapp/conectar — cria (ou reconecta) a
// instância e devolve um QR code novo pra escanear.
router.post('/estabelecimentos/:id/whatsapp/conectar', async (req, res) => {
  if (!evolution.evolutionConfigurada()) {
    return res.status(503).json({ erro: 'Evolution API não configurada neste ambiente ainda.' });
  }

  try {
    const qrCodeBase64 = await evolution.criarOuReconectarInstancia(req.params.id);
    await req.supabase
      .from('estabelecimentos')
      .update({ whatsapp_instancia: evolution.nomeInstancia(req.params.id), whatsapp_status: 'conectando' })
      .eq('id', req.params.id);

    res.json({ qrCodeBase64 });
  } catch (erro) {
    res.status(502).json({ erro: `Falha ao conectar com a Evolution API: ${erro.message}` });
  }
});

// GET /estabelecimentos/:id/whatsapp/status — lido do banco (rápido, sem
// bater na Evolution API a cada poll do front). Sincronizado pelo webhook.
router.get('/estabelecimentos/:id/whatsapp/status', async (req, res) => {
  const { data, error } = await req.supabase
    .from('estabelecimentos')
    .select('whatsapp_status, whatsapp_numero')
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// POST /estabelecimentos/:id/whatsapp/desconectar
router.post('/estabelecimentos/:id/whatsapp/desconectar', async (req, res) => {
  if (!evolution.evolutionConfigurada()) {
    return res.status(503).json({ erro: 'Evolution API não configurada neste ambiente ainda.' });
  }

  try {
    await evolution.desconectarInstancia(req.params.id);
  } catch (erro) {
    console.error('Falha ao desconectar instância Evolution:', erro.message);
  }

  const { error } = await req.supabase
    .from('estabelecimentos')
    .update({ whatsapp_status: 'desconectado', whatsapp_numero: null })
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ erro: error.message });
  res.sendStatus(204);
});

// GET /estabelecimentos/:id/whatsapp/contatos — contatos salvos no celular
// conectado, marcando quais já são clientes cadastrados (match por telefone).
router.get('/estabelecimentos/:id/whatsapp/contatos', async (req, res) => {
  if (!evolution.evolutionConfigurada()) {
    return res.status(503).json({ erro: 'Evolution API não configurada neste ambiente ainda.' });
  }

  let contatos;
  try {
    contatos = await evolution.buscarContatosSalvos(req.params.id);
  } catch (erro) {
    return res.status(502).json({ erro: `Falha ao buscar contatos na Evolution API: ${erro.message}` });
  }

  const { data: clientesExistentes } = await req.supabase
    .from('clientes')
    .select('telefone')
    .eq('estabelecimento_id', req.params.id);
  const telefonesExistentes = new Set((clientesExistentes || []).map(c => c.telefone));

  res.json(contatos.map(c => ({ ...c, ja_e_cliente: telefonesExistentes.has(c.telefone) })));

  registrarAcessoAuditoria(req.supabase, {
    estabelecimentoId: req.params.id,
    ator: req.user?.email || req.user?.id,
    operacao: 'read',
    tabela: 'clientes',
    detalhe: `Leitura de telefone (${telefonesExistentes.size} cliente(s)) pra cruzar com contatos do WhatsApp`,
  });
});

// POST /estabelecimentos/:id/whatsapp/contatos/importar
// Body: [{ nome, telefone }] — só os que o dono selecionou na tela de
// revisão. Ignora quem já é cliente (mesmo telefone) em vez de duplicar.
router.post('/estabelecimentos/:id/whatsapp/contatos/importar', async (req, res) => {
  const contatos = Array.isArray(req.body) ? req.body : [];
  const validos = contatos.filter(c => c?.telefone);
  if (!validos.length) return res.json({ importados: 0 });

  const { data: clientesExistentes } = await req.supabase
    .from('clientes')
    .select('telefone')
    .eq('estabelecimento_id', req.params.id);
  const telefonesExistentes = new Set((clientesExistentes || []).map(c => c.telefone));

  const novos = validos.filter(c => !telefonesExistentes.has(c.telefone));
  if (!novos.length) return res.json({ importados: 0 });

  const { error } = await req.supabase
    .from('clientes')
    .insert(novos.map(c => ({ estabelecimento_id: req.params.id, nome: c.nome || null, telefone: c.telefone })));

  if (error) return res.status(500).json({ erro: error.message });
  res.json({ importados: novos.length });

  registrarAcessoAuditoria(req.supabase, {
    estabelecimentoId: req.params.id,
    ator: req.user?.email || req.user?.id,
    operacao: 'write',
    tabela: 'clientes',
    detalhe: `Importou ${novos.length} cliente(s) novo(s) dos contatos do WhatsApp`,
  });
});

module.exports = router;
