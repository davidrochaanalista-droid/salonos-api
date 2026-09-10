/**
 * SalonOS API — Relatórios multi-unidade
 * =========================================
 * "Margem Real da Rede" (docs/SalonOS-estrategia-diferenciacao-2026.md,
 * Eixo 6): nenhum concorrente do comparativo calcula margem real por
 * comanda, então nenhum chega a essa consolidação. Rede aqui não é uma
 * tabela própria -- é implicitamente "todos os estabelecimentos do mesmo
 * proprietario_id" (o schema não usa o nível extra `redes`/`saloes` do
 * blueprint original; um proprietário já pode ter N estabelecimentos).
 */

const express = require('express');
const router = express.Router();

// GET /relatorios/margem-rede — margem real por estabelecimento do
// proprietário logado, mais o total ponderado por receita da rede toda.
router.get('/relatorios/margem-rede', async (req, res) => {
  const { data: proprietario, error: errProp } = await req.supabase
    .from('proprietarios')
    .select('id')
    .eq('user_id', req.user.id)
    .single();
  if (errProp || !proprietario) return res.status(404).json({ erro: 'Cadastro de proprietário não encontrado.' });

  const { data: estabelecimentos, error: errEst } = await req.supabase
    .from('estabelecimentos')
    .select('id, nome')
    .eq('proprietario_id', proprietario.id);
  if (errEst) return res.status(500).json({ erro: errEst.message });

  const porUnidade = [];
  let receitaTotal = 0;
  let margemTotal = 0;

  for (const estabelecimento of estabelecimentos) {
    const { data: comandas, error: errCom } = await req.supabase
      .from('comandas')
      .select('valor_total, margem')
      .eq('estabelecimento_id', estabelecimento.id)
      .eq('status', 'fechada');
    if (errCom) return res.status(500).json({ erro: errCom.message });

    const receita = comandas.reduce((soma, c) => soma + Number(c.valor_total), 0);
    const margem = comandas.reduce((soma, c) => soma + Number(c.margem), 0);

    porUnidade.push({
      estabelecimento_id: estabelecimento.id,
      nome: estabelecimento.nome,
      receita,
      margem,
      margem_percentual: receita > 0 ? Number(((margem / receita) * 100).toFixed(2)) : null,
      comandas_fechadas: comandas.length,
    });

    receitaTotal += receita;
    margemTotal += margem;
  }

  porUnidade.sort((a, b) => b.margem - a.margem);

  res.json({
    unidades: porUnidade,
    rede: {
      receita_total: receitaTotal,
      margem_total: margemTotal,
      margem_percentual_ponderada: receitaTotal > 0 ? Number(((margemTotal / receitaTotal) * 100).toFixed(2)) : null,
    },
  });
});

// GET /estabelecimentos/:id/resumo-mensal?ano_mes=2026-09-01 — tudo que o
// painel do proprietário precisa pra um card de unidade: receita, margem,
// ticket médio, top serviços, comissão por profissional, avaliação média,
// retenção, meta do mês e MRR (assinatura do salão com a SalonOS — ver
// nota de escopo em database/07-assinatura-avaliacoes-metas.sql: isto é
// dado de assinatura, não integra cobrança automática).
router.get('/estabelecimentos/:id/resumo-mensal', async (req, res) => {
  const estabelecimentoId = req.params.id;
  const anoMes = req.query.ano_mes || new Date().toISOString().slice(0, 7) + '-01';
  const inicioMes = new Date(anoMes + 'T00:00:00Z');
  const fimMes = new Date(Date.UTC(inicioMes.getUTCFullYear(), inicioMes.getUTCMonth() + 1, 1));
  const inicioAno = new Date(Date.UTC(inicioMes.getUTCFullYear(), 0, 1));

  const { data: estabelecimento, error: errEst } = await req.supabase
    .from('estabelecimentos')
    .select('id, nome, cidade, bairro, plano, status_assinatura, created_at')
    .eq('id', estabelecimentoId)
    .single();
  if (errEst || !estabelecimento) return res.status(404).json({ erro: 'Estabelecimento não encontrado ou sem permissão de acesso.' });

  const { data: comandasMes, error: errCom } = await req.supabase
    .from('comandas')
    .select('valor_total, margem, fechada_em, profissional_id')
    .eq('estabelecimento_id', estabelecimentoId)
    .eq('status', 'fechada')
    .gte('fechada_em', inicioMes.toISOString())
    .lt('fechada_em', fimMes.toISOString());
  if (errCom) return res.status(500).json({ erro: errCom.message });

  const { data: comandasAno } = await req.supabase
    .from('comandas')
    .select('valor_total')
    .eq('estabelecimento_id', estabelecimentoId)
    .eq('status', 'fechada')
    .gte('fechada_em', inicioAno.toISOString())
    .lt('fechada_em', fimMes.toISOString());

  const { data: itensMes } = await req.supabase
    .from('comanda_itens')
    .select('quantidade, estabelecimento_atividades(nome), comandas!inner(estabelecimento_id, status, fechada_em)')
    .eq('comandas.estabelecimento_id', estabelecimentoId)
    .eq('comandas.status', 'fechada')
    .gte('comandas.fechada_em', inicioMes.toISOString())
    .lt('comandas.fechada_em', fimMes.toISOString());

  const { data: profissionais } = await req.supabase
    .from('profissionais')
    .select('id, nome, comissao_padrao_percentual')
    .eq('estabelecimento_id', estabelecimentoId)
    .eq('ativo', true);

  const { data: avaliacoes } = await req.supabase
    .from('avaliacoes')
    .select('nota')
    .eq('estabelecimento_id', estabelecimentoId);

  const { data: meta } = await req.supabase
    .from('metas_mensais')
    .select('valor_meta')
    .eq('estabelecimento_id', estabelecimentoId)
    .eq('ano_mes', anoMes)
    .maybeSingle();

  const { data: planoPreco } = await req.supabase
    .from('planos_precos')
    .select('valor_mensal')
    .eq('plano', estabelecimento.plano)
    .maybeSingle();

  // ── Retenção: clientes com 2+ atendimentos nos últimos 90 dias ──
  const noventaDiasAtras = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { data: atendimentosRecentes } = await req.supabase
    .from('atendimentos')
    .select('cliente_id')
    .eq('estabelecimento_id', estabelecimentoId)
    .gte('data_atendimento', noventaDiasAtras);

  const contagemPorCliente = {};
  (atendimentosRecentes || []).forEach(a => { contagemPorCliente[a.cliente_id] = (contagemPorCliente[a.cliente_id] || 0) + 1; });
  const clientesUnicos = Object.keys(contagemPorCliente).length;
  const clientesRetidos = Object.values(contagemPorCliente).filter(n => n >= 2).length;
  const taxaRetencao = clientesUnicos > 0 ? Number(((clientesRetidos / clientesUnicos) * 100).toFixed(1)) : null;

  // ── Totais e agregações ──
  const recMes = comandasMes.reduce((s, c) => s + Number(c.valor_total), 0);
  const margemMes = comandasMes.reduce((s, c) => s + Number(c.margem), 0);
  const recAno = (comandasAno || []).reduce((s, c) => s + Number(c.valor_total), 0);

  const recSemanas = [0, 0, 0, 0];
  comandasMes.forEach(c => {
    const dia = new Date(c.fechada_em).getUTCDate();
    const semana = Math.min(3, Math.floor((dia - 1) / 7));
    recSemanas[semana] += Number(c.valor_total);
  });

  const receitaPorProfissional = {};
  comandasMes.forEach(c => {
    if (!c.profissional_id) return;
    receitaPorProfissional[c.profissional_id] = (receitaPorProfissional[c.profissional_id] || 0) + Number(c.valor_total);
  });
  const staffList = (profissionais || []).map(p => ({
    nome: p.nome,
    receita_mes: receitaPorProfissional[p.id] || 0,
    comissao_percentual: p.comissao_padrao_percentual,
  }));

  const qtdPorServico = {};
  (itensMes || []).forEach(item => {
    const nome = item.estabelecimento_atividades?.nome || 'Outro';
    qtdPorServico[nome] = (qtdPorServico[nome] || 0) + item.quantidade;
  });
  const totalItens = Object.values(qtdPorServico).reduce((a, b) => a + b, 0);
  const topServicos = Object.entries(qtdPorServico)
    .map(([nome, qtd]) => [nome, totalItens > 0 ? Math.round((qtd / totalItens) * 100) : 0])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const ratings = (avaliacoes || []).map(a => a.nota);
  const ratingMedio = ratings.length ? Number((ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1)) : null;

  res.json({
    id: estabelecimento.id,
    nome: estabelecimento.nome,
    cidade: estabelecimento.cidade,
    bairro: estabelecimento.bairro,
    plano: estabelecimento.plano,
    status_assinatura: estabelecimento.status_assinatura,
    desde: estabelecimento.created_at,
    ano_mes: anoMes,
    rec_mes: recMes,
    rec_ano: recAno,
    rec_semanas: recSemanas,
    mrr: estabelecimento.status_assinatura === 'ativo' ? Number(planoPreco?.valor_mensal || 0) : 0,
    agend_mes: comandasMes.length,
    ticket_med: comandasMes.length > 0 ? Number((recMes / comandasMes.length).toFixed(2)) : 0,
    margem_pct: recMes > 0 ? Number(((margemMes / recMes) * 100).toFixed(1)) : null,
    tax_retorno: taxaRetencao,
    rating: ratingMedio,
    staff: (profissionais || []).length,
    staff_list: staffList,
    top_servicos: topServicos,
    meta_mes: meta?.valor_meta ?? null,
  });
});

module.exports = router;
