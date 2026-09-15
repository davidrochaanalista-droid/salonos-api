/**
 * SalonOS API — Cobrança Pix via gateway (baixa automática de comanda)
 * =======================================================================
 * Dois routers neste arquivo porque as duas rotas têm dono diferente:
 * `router` (export padrão) é autenticado, roda com req.supabase+RLS, dono
 * do salão cobrando a própria comanda -- montado depois de `autenticar`
 * em server.js, junto dos outros. `webhookRouter` é chamado pelo PROVEDOR
 * de pagamento, nunca por um usuário logado -- monta ANTES de `autenticar`
 * (mesmo motivo do webhook do WhatsApp, ver routes/whatsapp.js) e usa um
 * client service_role que bypassa RLS por desenho.
 */

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { decryptSensitive } = require('../lib/crypto');
const { obterAdapter } = require('../lib/gateways');
const { dispararAvaliacoes } = require('./comandas');

const router = express.Router();
const webhookRouter = express.Router();

const supabaseServico = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// decryptSensitive/JSON.parse lançam exceção síncrona em dado corrompido ou
// numa rotação de CRYPTO_KEY (mesmo cuidado já tomado em todo outro lugar
// que usa decryptSensitive, ver clientes.js) -- sem isso, uma rota async do
// Express 4 sem try/catch trava esperando resposta em vez de devolver erro.
function decodificarCredenciais(blobCifrado, contexto) {
  try {
    return JSON.parse(decryptSensitive(blobCifrado));
  } catch (erro) {
    console.error(`Falha ao descriptografar credencial de gateway (${contexto}):`, erro.message);
    return null;
  }
}

// POST /comandas/:id/cobrar-pix — gera uma cobrança Pix de verdade (gateway
// configurado pelo dono) pro valor total já lançado na comanda aberta.
router.post('/comandas/:id/cobrar-pix', async (req, res) => {
  const { data: comanda, error: errComanda } = await req.supabase
    .from('comandas')
    .select('id, estabelecimento_id, cliente_id, status, itens:comanda_itens(quantidade, preco_unitario), clientes(nome)')
    .eq('id', req.params.id)
    .single();
  if (errComanda) return res.status(404).json({ erro: 'Comanda não encontrada ou sem permissão de acesso.' });
  if (comanda.status !== 'aberta') return res.status(400).json({ erro: 'Comanda não está aberta.' });

  const valor = (comanda.itens || []).reduce((soma, item) => soma + item.quantidade * Number(item.preco_unitario), 0);
  if (valor <= 0) return res.status(400).json({ erro: 'Comanda ainda não tem itens lançados.' });

  const { data: estabelecimento, error: errEstab } = await req.supabase
    .from('estabelecimentos')
    .select('gateway_pagamento, gateway_credenciais_criptografadas')
    .eq('id', comanda.estabelecimento_id)
    .single();
  if (errEstab || !estabelecimento?.gateway_pagamento || !estabelecimento.gateway_credenciais_criptografadas) {
    return res.status(400).json({ erro: 'Este estabelecimento ainda não configurou um gateway de pagamento.' });
  }

  const adapter = obterAdapter(estabelecimento.gateway_pagamento);
  const credenciais = decodificarCredenciais(estabelecimento.gateway_credenciais_criptografadas, `cobrar-pix, estabelecimento ${comanda.estabelecimento_id}`);
  if (!credenciais) return res.status(500).json({ erro: 'Não foi possível ler a credencial do gateway configurado.' });

  let cobranca;
  try {
    cobranca = await adapter.criarCobranca({
      credenciais,
      valor,
      comandaId: comanda.id,
      descricao: `Comanda SalonOS ${comanda.id}`,
      estabelecimentoId: comanda.estabelecimento_id,
      nomePagador: comanda.clientes?.nome, // já existe no cadastro -- não precisa inventar (CPF continua de fora, ver asaas.js)
      clienteId: comanda.cliente_id,
    });
  } catch (erro) {
    return res.status(502).json({ erro: `Falha ao gerar a cobrança no gateway: ${erro.message}` });
  }

  const { data: registro, error: errSalvar } = await req.supabase
    .from('cobrancas_pix')
    .insert({
      estabelecimento_id: comanda.estabelecimento_id,
      comanda_id: comanda.id,
      gateway: estabelecimento.gateway_pagamento,
      cobranca_id_externo: cobranca.cobrancaIdExterno,
      valor,
      copia_cola: cobranca.copiaCola,
      qr_data_url: cobranca.qrDataUrl,
    })
    .select('id, copia_cola, qr_data_url, valor')
    .single();

  if (errSalvar) return res.status(500).json({ erro: errSalvar.message });
  res.status(201).json(registro);
});

// POST /webhooks/pix/:gateway/:estabelecimentoId — o provedor avisa que um
// Pix caiu. Idempotente por desenho (só dá baixa se a cobrança ainda
// estiver 'pendente'), porque todo provedor Pix reentrega evento.
webhookRouter.post('/webhooks/pix/:gateway/:estabelecimentoId', async (req, res) => {
  const { gateway, estabelecimentoId } = req.params;

  let adapter;
  try {
    adapter = obterAdapter(gateway);
  } catch {
    return res.sendStatus(404);
  }

  const { data: estabelecimento, error: errEstab } = await supabaseServico
    .from('estabelecimentos')
    .select('gateway_pagamento, gateway_credenciais_criptografadas')
    .eq('id', estabelecimentoId)
    .single();
  if (errEstab || estabelecimento.gateway_pagamento !== gateway || !estabelecimento.gateway_credenciais_criptografadas) {
    return res.sendStatus(404);
  }

  const credenciais = decodificarCredenciais(estabelecimento.gateway_credenciais_criptografadas, `webhook ${gateway}, estabelecimento ${estabelecimentoId}`);
  // dado corrompido/chave rotacionada não é culpa do provedor -- reconhece
  // o recebimento (200) em vez de deixar ele reentregando pra sempre.
  if (!credenciais) return res.sendStatus(200);

  if (!adapter.verificarWebhook(req, credenciais)) return res.sendStatus(401);

  let evento;
  try {
    evento = await adapter.extrairEventoPago(req, credenciais);
  } catch (erro) {
    // não deixa o provedor ficar reentregando pra sempre um evento que
    // sempre vai quebrar do nosso lado -- loga e reconhece o recebimento.
    console.error('Falha ao processar webhook de pagamento:', erro.message);
    return res.sendStatus(200);
  }

  if (!evento || !evento.aprovado) return res.sendStatus(200);

  const { data: cobrancaAtualizada, error: errUpdate } = await supabaseServico
    .from('cobrancas_pix')
    .update({ status: 'pago', pago_em: new Date().toISOString() })
    .eq('estabelecimento_id', estabelecimentoId)
    .eq('gateway', gateway)
    .eq('cobranca_id_externo', evento.cobrancaIdExterno)
    .eq('status', 'pendente')
    .select('comanda_id')
    .single();

  // errUpdate aqui normalmente significa "0 linhas bateram o filtro" --
  // ou já foi processado antes (reentrega) ou é uma cobrança desconhecida.
  // De qualquer forma, 200: não é um erro do ponto de vista do provedor.
  if (errUpdate || !cobrancaAtualizada) return res.sendStatus(200);

  const { error: errFechar } = await supabaseServico.rpc('fechar_comanda', {
    p_comanda_id: cobrancaAtualizada.comanda_id,
    p_forma_pagamento: 'pix',
  });
  if (errFechar) console.error('Falha ao dar baixa automática na comanda via Pix:', errFechar.message);

  dispararAvaliacoes(supabaseServico, cobrancaAtualizada.comanda_id).catch(erro =>
    console.error('Falha ao disparar link de avaliação:', erro.message)
  );

  res.sendStatus(200);
});

module.exports = router;
module.exports.webhookRouter = webhookRouter;
