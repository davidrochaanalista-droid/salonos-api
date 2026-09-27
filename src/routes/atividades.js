/**
 * SalonOS API — Rotas de Segmentos e Atividades
 * ================================================
 * Segmentos e catálogo são de leitura pública (RLS permite select
 * sem restrição — ver schema, seção 7). As demais rotas exigem que
 * o estabelecimento pertença ao usuário logado, garantido pelo RLS
 * de estabelecimento_atividades.
 */

const express = require('express');
const router = express.Router();

// GET /segmentos — lista os segmentos disponíveis para venda (para a tela de cadastro)
// Segmentos de saúde regulada (nutricionista, psicologia, odontologia,
// fisioterapia) ficam marcados `ativo = false` por decisão consciente —
// ver database/06-desativar-segmentos-saude-regulada.sql.
router.get('/segmentos', async (req, res) => {
  const { data, error } = await req.supabase
    .from('segmentos')
    .select('*')
    .eq('ativo', true)
    .order('ordem');

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// GET /atividades-catalogo?segmento_id=... — catálogo sugerido para um segmento
router.get('/atividades-catalogo', async (req, res) => {
  const { segmento_id } = req.query;
  if (!segmento_id) return res.status(400).json({ erro: 'segmento_id é obrigatório.' });

  const { data, error } = await req.supabase
    .from('atividades_catalogo')
    .select('*')
    .eq('segmento_id', segmento_id)
    .order('ordem');

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// GET /estabelecimentos/:id/atividades — atividades já vinculadas ao estabelecimento
router.get('/estabelecimentos/:id/atividades', async (req, res) => {
  const { data, error } = await req.supabase
    .from('estabelecimento_atividades')
    .select('*')
    .eq('estabelecimento_id', req.params.id)
    .order('created_at');

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// POST /estabelecimentos/:id/atividades — adota uma atividade do catálogo, ou cadastra customizada
// Body: { atividade_catalogo_id? , nome, descricao?, duracao_min?, preco }
router.post('/estabelecimentos/:id/atividades', async (req, res) => {
  const { atividade_catalogo_id, nome, descricao, duracao_min, preco, preco_variavel } = req.body;
  if (!nome || preco === undefined) {
    return res.status(400).json({ erro: 'nome e preco são obrigatórios.' });
  }

  const { data, error } = await req.supabase
    .from('estabelecimento_atividades')
    .insert({
      estabelecimento_id: req.params.id,
      atividade_catalogo_id: atividade_catalogo_id || null,
      nome, descricao, duracao_min, preco, preco_variavel,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.status(201).json(data);
});

// Adota TODAS as atividades sugeridas do catálogo de um segmento de uma vez
// -- usado pelo atalho abaixo (dono aciona manualmente) e pelo auto-seed do
// cadastro novo (POST /estabelecimentos, tela 2 -- ver estabelecimentos.js).
// proprietário ajusta preço/remove depois; usamos o piso da faixa sugerida
// como ponto de partida.
// Aceita um segmento ou uma lista (salão com vários segmentos -- ver
// database/38-multiplos-segmentos.sql). Serviço com o mesmo nome em dois
// segmentos entra uma vez só (o do primeiro segmento da lista vence).
async function adotarCatalogoCompleto(supabase, estabelecimentoId, segmentoIds) {
  const ids = Array.isArray(segmentoIds) ? segmentoIds : [segmentoIds];
  const { data: catalogoBruto, error: errCat } = await supabase
    .from('atividades_catalogo')
    .select('*')
    .in('segmento_id', ids);
  if (errCat) throw new Error(errCat.message);

  const vistos = new Set();
  const catalogo = catalogoBruto
    .sort((a, b) => ids.indexOf(a.segmento_id) - ids.indexOf(b.segmento_id) || (a.ordem ?? 0) - (b.ordem ?? 0))
    .filter(a => {
      const chave = a.nome.trim().toLowerCase();
      if (vistos.has(chave)) return false;
      vistos.add(chave);
      return true;
    });
  if (!catalogo.length) return [];

  const inserts = catalogo.map(a => ({
    estabelecimento_id: estabelecimentoId,
    atividade_catalogo_id: a.id,
    nome: a.nome,
    descricao: a.descricao_curta,
    duracao_min: a.duracao_padrao_min,
    preco: a.preco_sugerido_min,
  }));

  const { data, error } = await supabase.from('estabelecimento_atividades').insert(inserts).select();
  if (error) throw new Error(error.message);
  return data;
}

// Lê a lista de segmentos do corpo da requisição -- `segmentos_ids` (novo,
// vários) ou `segmento_id` (formato antigo, um só) -- e valida contra a
// tabela: remove repetidos, exige pelo menos 1, só aceita segmento ativo.
// Devolve os ids na ordem escolhida (o primeiro vira o segmento principal,
// estabelecimentos.segmento_id). Lança erro com .status=400 se inválido.
const MAX_SEGMENTOS = 10;
async function validarSegmentos(supabase, { segmentos_ids, segmento_id }) {
  const bruto = Array.isArray(segmentos_ids) ? segmentos_ids : (segmento_id ? [segmento_id] : []);
  const ids = [...new Set(bruto.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))];
  const falha = (mensagem) => Object.assign(new Error(mensagem), { status: 400 });

  if (!ids.length) throw falha('Escolha pelo menos um segmento.');
  if (ids.length > MAX_SEGMENTOS) throw falha(`No máximo ${MAX_SEGMENTOS} segmentos.`);

  const { data, error } = await supabase.from('segmentos').select('id').in('id', ids).eq('ativo', true);
  if (error) throw new Error(error.message);
  if (data.length !== ids.length) throw falha('Segmento inválido ou indisponível.');
  return ids;
}

// POST /estabelecimentos/:id/atividades/adotar-catalogo-completo — atalho para
// o cadastro inicial: adota TODAS as atividades sugeridas do segmento de uma vez,
// o proprietário depois remove/edita o que não quiser (fluxo descrito no README-fase1.md, Decisão 1)
router.post('/estabelecimentos/:id/atividades/adotar-catalogo-completo', async (req, res) => {
  const { data: estabelecimento, error: errEst } = await req.supabase
    .from('estabelecimentos')
    .select('segmento_id, segmentos_ids')
    .eq('id', req.params.id)
    .single();

  if (errEst || !estabelecimento) return res.status(404).json({ erro: 'Estabelecimento não encontrado.' });

  try {
    const segmentos = estabelecimento.segmentos_ids?.length ? estabelecimento.segmentos_ids : [estabelecimento.segmento_id];
    const data = await adotarCatalogoCompleto(req.supabase, req.params.id, segmentos);
    res.status(201).json(data);
  } catch (erro) {
    res.status(500).json({ erro: erro.message });
  }
});

// PATCH /atividades/:id — editar preço/duração/status de uma atividade já vinculada
router.patch('/atividades/:id', async (req, res) => {
  const camposPermitidos = ['nome', 'descricao', 'duracao_min', 'preco', 'ativo', 'ciclo_recompra_dias', 'preco_variavel'];
  const atualizacoes = {};
  for (const campo of camposPermitidos) {
    if (req.body[campo] !== undefined) atualizacoes[campo] = req.body[campo];
  }

  const { data, error } = await req.supabase
    .from('estabelecimento_atividades')
    .update(atualizacoes)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// DELETE /atividades/:id — tenta apagar de vez; se o serviço já foi
// usado em algum lugar (agendamento, comanda, atendimento, automação,
// receita...), o banco recusa por causa das foreign keys (nenhuma tem
// ON DELETE CASCADE, de propósito -- apagar de vez quebraria o
// histórico de comandas já fechadas). Nesse caso, desativa em vez de
// falhar sem explicação.
router.delete('/atividades/:id', async (req, res) => {
  const { error } = await req.supabase
    .from('estabelecimento_atividades')
    .delete()
    .eq('id', req.params.id);

  if (!error) return res.json({ ok: true, apagado: true });

  if (error.code === '23503') {
    const { error: errDesativar } = await req.supabase
      .from('estabelecimento_atividades')
      .update({ ativo: false })
      .eq('id', req.params.id);
    if (errDesativar) return res.status(500).json({ erro: errDesativar.message });
    return res.json({ ok: true, apagado: false, motivo: 'ja_usado' });
  }

  res.status(500).json({ erro: error.message });
});

module.exports = router;
module.exports.adotarCatalogoCompleto = adotarCatalogoCompleto;
module.exports.validarSegmentos = validarSegmentos;
