/**
 * SalonOS API — Rotas de Estoque (produtos + receita por serviço)
 * ==================================================================
 * "Receita" (estabelecimento_atividade_produtos) é quanto de cada
 * produto um serviço consome por atendimento -- usada pela função
 * fechar_comanda (database/16-...sql) pra dar baixa automática no
 * estoque quando a comanda fecha.
 */

const express = require('express');
const Groq = require('groq-sdk');

const router = express.Router();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Catálogo de modelos com visão da Groq já mudou de nome antes nesse
// projeto (ver GROQ_MODEL em whatsapp.js) -- configurável pelo mesmo motivo.
const MODELO_VISAO = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.6-27b';

// GET /estabelecimentos/:id/produtos
router.get('/estabelecimentos/:id/produtos', async (req, res) => {
  const { data, error } = await req.supabase
    .from('produtos')
    .select('*')
    .eq('estabelecimento_id', req.params.id)
    .order('nome');

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// POST /estabelecimentos/:id/produtos
router.post('/estabelecimentos/:id/produtos', async (req, res) => {
  const { nome, marca, categoria, unidade, custo_unitario, quantidade_em_estoque, estoque_minimo, validade, foto_url, preco_venda } = req.body;
  if (!nome) return res.status(400).json({ erro: 'nome é obrigatório.' });

  const { data, error } = await req.supabase
    .from('produtos')
    .insert({
      estabelecimento_id: req.params.id,
      nome, marca, categoria,
      unidade: unidade || 'un',
      custo_unitario: custo_unitario ?? 0,
      quantidade_em_estoque: quantidade_em_estoque ?? 0,
      estoque_minimo: estoque_minimo ?? 0,
      validade, foto_url,
      preco_venda: preco_venda || null,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.status(201).json(data);
});

// PATCH /produtos/:id
router.patch('/produtos/:id', async (req, res) => {
  const camposPermitidos = ['nome', 'marca', 'categoria', 'unidade', 'custo_unitario', 'quantidade_em_estoque', 'estoque_minimo', 'validade', 'foto_url', 'ativo', 'preco_venda'];
  const atualizacoes = {};
  for (const campo of camposPermitidos) {
    if (req.body[campo] !== undefined) atualizacoes[campo] = req.body[campo];
  }

  // quantidade_em_estoque só é editável direto enquanto o produto não tem
  // lote (migração 22) -- com lote, esse campo é um agregado mantido por
  // trigger (soma de produto_lotes.quantidade_atual) e seria sobrescrito
  // silenciosamente no próximo ajuste de lote. Ignorar aqui em vez de
  // deixar o usuário achar que editou algo que não vai persistir.
  if (atualizacoes.quantidade_em_estoque !== undefined) {
    const { count } = await req.supabase
      .from('produto_lotes')
      .select('id', { count: 'exact', head: true })
      .eq('produto_id', req.params.id);
    if (count > 0) delete atualizacoes.quantidade_em_estoque;
  }

  const { data, error } = await req.supabase
    .from('produtos')
    .update(atualizacoes)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// POST /estabelecimentos/:id/produtos/identificar-foto
// Body: { imagem_base64 } -- só retorna sugestão, não cria produto nenhum.
router.post('/estabelecimentos/:id/produtos/identificar-foto', async (req, res) => {
  const { imagem_base64 } = req.body;
  if (!imagem_base64) return res.status(400).json({ erro: 'imagem_base64 é obrigatório.' });

  const base64 = imagem_base64.includes(',') ? imagem_base64.split(',')[1] : imagem_base64;

  try {
    const resposta = await groq.chat.completions.create({
      model: MODELO_VISAO,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Extraia marca, descrição curta e data de validade (formato YYYY-MM-DD, ou null se não estiver visível) deste produto de salão de beleza. Responda SOMENTE com JSON: {"marca":"...","descricao":"...","validade":"YYYY-MM-DD ou null"}' },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
        ],
      }],
      temperature: 0,
      response_format: { type: 'json_object' },
    });

    const texto = resposta.choices[0].message.content;
    const sugestao = JSON.parse(texto);
    res.json({
      marca: sugestao.marca || null,
      descricao: sugestao.descricao || null,
      validade: sugestao.validade && sugestao.validade !== 'null' ? sugestao.validade : null,
    });
  } catch (erro) {
    // Identificação é só sugestão pro formulário -- se a Groq falhar ou
    // não devolver JSON válido, o cadastro manual continua funcionando.
    console.error('Falha ao identificar produto por foto:', erro.message);
    res.json({ marca: null, descricao: null, validade: null });
  }
});

// GET /produtos/:id/lotes
router.get('/produtos/:id/lotes', async (req, res) => {
  const { data, error } = await req.supabase
    .from('produto_lotes')
    .select('*')
    .eq('produto_id', req.params.id)
    .order('validade', { ascending: true, nullsFirst: false });

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// POST /produtos/:id/lotes
router.post('/produtos/:id/lotes', async (req, res) => {
  const { numero_lote, quantidade_inicial, validade, data_entrada, custo_unitario } = req.body;
  if (quantidade_inicial === undefined) return res.status(400).json({ erro: 'quantidade_inicial é obrigatório.' });

  const { data: produto, error: errProduto } = await req.supabase
    .from('produtos')
    .select('estabelecimento_id, quantidade_em_estoque')
    .eq('id', req.params.id)
    .single();
  if (errProduto || !produto) return res.status(404).json({ erro: 'Produto não encontrado ou sem permissão de acesso.' });

  // Primeiro lote deste produto, com estoque legado (editado direto via
  // PATCH antes de existir lote) -- o trigger sync_quantidade_estoque_produto
  // (migração 22) recalcula quantidade_em_estoque como soma dos lotes assim
  // que o primeiro lote entra, o que perderia esse estoque legado em
  // silêncio. Cria um lote implícito representando o que já tinha, pra
  // manter a continuidade (total depois = legado + lote novo).
  const { count: totalLotes } = await req.supabase
    .from('produto_lotes')
    .select('id', { count: 'exact', head: true })
    .eq('produto_id', req.params.id);
  if (!totalLotes && produto.quantidade_em_estoque > 0) {
    const { error: errLegado } = await req.supabase.from('produto_lotes').insert({
      produto_id: req.params.id,
      estabelecimento_id: produto.estabelecimento_id,
      numero_lote: null,
      quantidade_inicial: produto.quantidade_em_estoque,
      quantidade_atual: produto.quantidade_em_estoque,
      validade: null,
    });
    if (errLegado) return res.status(500).json({ erro: errLegado.message });
  }

  const { data, error } = await req.supabase
    .from('produto_lotes')
    .insert({
      produto_id: req.params.id,
      estabelecimento_id: produto.estabelecimento_id,
      numero_lote, validade, custo_unitario,
      data_entrada: data_entrada || undefined,
      quantidade_inicial,
      quantidade_atual: quantidade_inicial,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.status(201).json(data);
});

// PATCH /lotes/:id — ajuste manual (perda, correção)
router.patch('/lotes/:id', async (req, res) => {
  const camposPermitidos = ['quantidade_atual', 'validade', 'numero_lote'];
  const atualizacoes = {};
  for (const campo of camposPermitidos) {
    if (req.body[campo] !== undefined) atualizacoes[campo] = req.body[campo];
  }

  const { data, error } = await req.supabase
    .from('produto_lotes')
    .update(atualizacoes)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// GET /estabelecimentos/:id/lotes-vencendo?dias=30
router.get('/estabelecimentos/:id/lotes-vencendo', async (req, res) => {
  const dias = req.query.dias !== undefined && Number.isFinite(Number(req.query.dias)) ? Number(req.query.dias) : 30;
  const limite = new Date();
  limite.setDate(limite.getDate() + dias);

  const { data, error } = await req.supabase
    .from('produto_lotes')
    .select('*, produtos(nome)')
    .eq('estabelecimento_id', req.params.id)
    .gt('quantidade_atual', 0)
    .lte('validade', limite.toISOString().slice(0, 10))
    .order('validade', { ascending: true });

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// POST /produtos/:id/vender — venda avulsa no balcão, fora de uma comanda
// de serviço (ex: cliente compra um shampoo de revenda). Dá baixa por FEFO
// (mesma função da baixa de insumo em comanda, migração 22) e lança a
// entrada no caixa -- tudo dentro de vender_produto_avulso (migração 32).
router.post('/produtos/:id/vender', async (req, res) => {
  const { quantidade, forma_pagamento } = req.body;
  if (!quantidade) return res.status(400).json({ erro: 'quantidade é obrigatória.' });
  if (!forma_pagamento) return res.status(400).json({ erro: 'forma_pagamento é obrigatória.' });

  const { data, error } = await req.supabase.rpc('vender_produto_avulso', {
    p_produto_id: req.params.id,
    p_quantidade: quantidade,
    p_forma_pagamento: forma_pagamento,
  });

  if (error) return res.status(400).json({ erro: error.message });
  res.status(201).json(data);
});

// GET /atividades/:id/receita
router.get('/atividades/:id/receita', async (req, res) => {
  const { data, error } = await req.supabase
    .from('estabelecimento_atividade_produtos')
    .select('*, produtos(nome, unidade)')
    .eq('estabelecimento_atividade_id', req.params.id);

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// PUT /atividades/:id/receita — substitui a lista inteira
// Body: [{produto_id, quantidade_usada}]
// Nota: delete + insert em duas chamadas separadas, não é atômico (o
// client REST do Supabase não dá transação multi-tabela fácil aqui) --
// numa falha no meio, a receita pode ficar vazia até tentar de novo.
router.put('/atividades/:id/receita', async (req, res) => {
  const itens = Array.isArray(req.body) ? req.body : [];

  const { error: errDelete } = await req.supabase
    .from('estabelecimento_atividade_produtos')
    .delete()
    .eq('estabelecimento_atividade_id', req.params.id);
  if (errDelete) return res.status(500).json({ erro: errDelete.message });

  if (!itens.length) return res.json([]);

  const { data, error } = await req.supabase
    .from('estabelecimento_atividade_produtos')
    .insert(itens.map(i => ({
      estabelecimento_atividade_id: req.params.id,
      produto_id: i.produto_id,
      quantidade_usada: i.quantidade_usada,
    })))
    .select();

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// DELETE /produtos/:id — tenta apagar de vez; se o produto já está numa
// receita de serviço ou já tem lote registrado, o banco recusa por causa
// das foreign keys (sem ON DELETE CASCADE, de propósito -- apagar de vez
// quebraria a baixa automática de estoque já configurada). Nesse caso,
// desativa em vez de falhar sem explicação -- mesmo padrão de
// DELETE /atividades/:id.
router.delete('/produtos/:id', async (req, res) => {
  const { error } = await req.supabase
    .from('produtos')
    .delete()
    .eq('id', req.params.id);

  if (!error) return res.json({ ok: true, apagado: true });

  if (error.code === '23503') {
    const { error: errDesativar } = await req.supabase
      .from('produtos')
      .update({ ativo: false })
      .eq('id', req.params.id);
    if (errDesativar) return res.status(500).json({ erro: errDesativar.message });
    return res.json({ ok: true, apagado: false, motivo: 'ja_usado' });
  }

  res.status(500).json({ erro: error.message });
});

module.exports = router;
