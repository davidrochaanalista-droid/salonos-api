/**
 * SalonOS API — Rotas de Comanda
 * ================================
 * É aqui que a margem real nasce (docs/SalonOS-estrategia-diferenciacao-2026.md,
 * Eixo 1): cada item de comanda sabe o preço cobrado, o custo do insumo e a
 * comissão da profissional. Fechar a comanda (RPC `fechar_comanda`, ver
 * database/05-agenda-comanda-caixa.sql) calcula os totais, gera o lançamento
 * de caixa (que dispara o "ao vivo" via LISTEN/NOTIFY) e grava o atendimento
 * no histórico -- sem isso, a pergunta "mesmo procedimento de sempre?" da IA
 * do WhatsApp nunca teria dado real para se basear.
 */

const express = require('express');
const { enviarMensagemWhatsApp } = require('./whatsapp');
const router = express.Router();

// POST /estabelecimentos/:id/comandas — abrir uma comanda
router.post('/estabelecimentos/:id/comandas', async (req, res) => {
  const { cliente_id, profissional_id, agendamento_id } = req.body;
  if (!cliente_id) return res.status(400).json({ erro: 'cliente_id é obrigatório.' });

  const { data, error } = await req.supabase
    .from('comandas')
    .insert({ estabelecimento_id: req.params.id, cliente_id, profissional_id, agendamento_id })
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.status(201).json(data);
});

// GET /estabelecimentos/:id/comandas?status=&desde=&ate=
router.get('/estabelecimentos/:id/comandas', async (req, res) => {
  const { status, desde, ate } = req.query;
  let consulta = req.supabase
    .from('comandas')
    .select('*, clientes(nome, telefone), profissionais(nome)')
    .eq('estabelecimento_id', req.params.id)
    .order('aberta_em', { ascending: false });

  if (status) consulta = consulta.eq('status', status);
  if (desde) consulta = consulta.gte('aberta_em', desde);
  if (ate) consulta = consulta.lte('aberta_em', ate);

  const { data, error } = await consulta;
  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// GET /comandas/:id — detalhe com itens
router.get('/comandas/:id', async (req, res) => {
  const { data: comanda, error } = await req.supabase
    .from('comandas')
    .select('*, clientes(nome, telefone), profissionais(nome)')
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(404).json({ erro: 'Comanda não encontrada ou sem permissão de acesso.' });

  const { data: itens } = await req.supabase
    .from('comanda_itens')
    .select('*, estabelecimento_atividades(nome)')
    .eq('comanda_id', req.params.id);

  res.json({ ...comanda, itens: itens || [] });
});

// POST /comandas/:id/itens — adicionar um serviço à comanda
// Custo/comissão são copiados do cadastro (estabelecimento_atividades /
// profissionais) por padrão, mas podem ser sobrescritos no corpo da
// requisição (ex.: comissão negociada diferente para aquele atendimento).
router.post('/comandas/:id/itens', async (req, res) => {
  const { estabelecimento_atividade_id, quantidade, preco_unitario, custo_insumo_unitario, comissao_percentual } = req.body;
  if (!estabelecimento_atividade_id) return res.status(400).json({ erro: 'estabelecimento_atividade_id é obrigatório.' });

  const { data: comanda } = await req.supabase.from('comandas').select('profissional_id').eq('id', req.params.id).single();

  const { data: atividade, error: errAtividade } = await req.supabase
    .from('estabelecimento_atividades')
    .select('preco, custo_insumo_padrao')
    .eq('id', estabelecimento_atividade_id)
    .single();
  if (errAtividade) return res.status(404).json({ erro: 'Atividade não encontrada.' });

  let comissaoPadrao = 0;
  if (comanda?.profissional_id) {
    const { data: profissional } = await req.supabase
      .from('profissionais')
      .select('comissao_padrao_percentual')
      .eq('id', comanda.profissional_id)
      .single();
    comissaoPadrao = profissional?.comissao_padrao_percentual || 0;
  }

  const { data, error } = await req.supabase
    .from('comanda_itens')
    .insert({
      comanda_id: req.params.id,
      estabelecimento_atividade_id,
      quantidade: quantidade || 1,
      preco_unitario: preco_unitario ?? atividade.preco,
      custo_insumo_unitario: custo_insumo_unitario ?? atividade.custo_insumo_padrao,
      comissao_percentual: comissao_percentual ?? comissaoPadrao,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.status(201).json(data);
});

// DELETE /comandas/:id/itens/:itemId — remover item antes de fechar
router.delete('/comandas/:id/itens/:itemId', async (req, res) => {
  const { error } = await req.supabase.from('comanda_itens').delete().eq('id', req.params.itemId).eq('comanda_id', req.params.id);
  if (error) return res.status(500).json({ erro: error.message });
  res.sendStatus(204);
});

// POST /comandas/:id/fechar — calcula totais, grava caixa e histórico
// (tudo dentro da função fechar_comanda, ver database/05-agenda-comanda-caixa.sql)
router.post('/comandas/:id/fechar', async (req, res) => {
  const { forma_pagamento } = req.body;
  if (!forma_pagamento) return res.status(400).json({ erro: 'forma_pagamento é obrigatório.' });

  const { data, error } = await req.supabase.rpc('fechar_comanda', {
    p_comanda_id: req.params.id,
    p_forma_pagamento: forma_pagamento,
  });

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);

  dispararAvaliacoes(req.supabase, req.params.id).catch(erroAvaliacao =>
    console.error('Falha ao disparar link de avaliação:', erroAvaliacao)
  );
});

// Depois de fechar a comanda, manda um link de avaliação por WhatsApp pra
// cada atendimento gerado. Fire-and-forget: nunca deve afetar a resposta
// HTTP de /fechar, e enviarMensagemWhatsApp já loga e retorna em silêncio
// se a Evolution API não estiver configurada (ver src/routes/whatsapp.js).
async function dispararAvaliacoes(supabase, comandaId) {
  const baseUrl = process.env.PUBLIC_BASE_URL;
  if (!baseUrl) return;

  const { data: atendimentos } = await supabase
    .from('atendimentos')
    .select('id, clientes(nome, telefone)')
    .eq('comanda_id', comandaId);

  for (const atendimento of atendimentos || []) {
    const telefone = atendimento.clientes?.telefone;
    if (!telefone) continue;

    const link = `${baseUrl}/avaliar.html?atendimento_id=${atendimento.id}`;
    const texto = `Oi! Como foi seu atendimento? Sua avaliação ajuda muito: ${link}`;
    await enviarMensagemWhatsApp({ telefone, texto });
  }
}

module.exports = router;
