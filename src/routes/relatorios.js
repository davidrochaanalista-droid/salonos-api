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

module.exports = router;
