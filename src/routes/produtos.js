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
  const { nome, marca, categoria, unidade, custo_unitario, quantidade_em_estoque, estoque_minimo, validade, foto_url } = req.body;
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
    })
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.status(201).json(data);
});

// PATCH /produtos/:id
router.patch('/produtos/:id', async (req, res) => {
  const camposPermitidos = ['nome', 'marca', 'categoria', 'unidade', 'custo_unitario', 'quantidade_em_estoque', 'estoque_minimo', 'validade', 'foto_url', 'ativo'];
  const atualizacoes = {};
  for (const campo of camposPermitidos) {
    if (req.body[campo] !== undefined) atualizacoes[campo] = req.body[campo];
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

module.exports = router;
