/**
 * SalonOS API — Rotas de Automações
 * ===================================
 * As 7 linhas (uma por tipo) são garantidas sob demanda no GET -- assim
 * não precisa de seed manual toda vez que um estabelecimento novo é
 * criado. Todas nascem `ativa=false` exceto avaliacao_pos_atendimento
 * (o gatilho já roda de verdade desde fechar_comanda, então já é
 * apresentada como ativa).
 */

const express = require('express');
const router = express.Router();

const TIPOS_AUTOMACAO = [
  'confirmacao_24h',
  'reativacao_clientes',
  'aniversario',
  'retorno_ciclo',
  'upsell_agendamento',
  'lista_espera',
  'avaliacao_pos_atendimento',
];

async function garantirAutomacoes(supabase, estabelecimentoId) {
  const { data: existentes } = await supabase
    .from('automacoes')
    .select('tipo')
    .eq('estabelecimento_id', estabelecimentoId);

  const tiposExistentes = new Set((existentes || []).map(a => a.tipo));
  const faltando = TIPOS_AUTOMACAO.filter(t => !tiposExistentes.has(t));

  if (faltando.length) {
    await supabase.from('automacoes').insert(
      faltando.map(tipo => ({
        estabelecimento_id: estabelecimentoId,
        tipo,
        ativa: tipo === 'avaliacao_pos_atendimento',
      }))
    );
  }
}

// GET /estabelecimentos/:id/automacoes — lista as 7, com contagem de disparos (30 dias)
router.get('/estabelecimentos/:id/automacoes', async (req, res) => {
  await garantirAutomacoes(req.supabase, req.params.id);

  const { data: automacoes, error } = await req.supabase
    .from('automacoes')
    .select('*')
    .eq('estabelecimento_id', req.params.id);

  if (error) return res.status(500).json({ erro: error.message });

  const desde = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const comContagem = await Promise.all(automacoes.map(async (automacao) => {
    const { count } = await req.supabase
      .from('automacao_disparos')
      .select('id', { count: 'exact', head: true })
      .eq('automacao_id', automacao.id)
      .gte('disparado_em', desde);
    return { ...automacao, disparos_30d: count || 0 };
  }));

  res.json(comContagem);
});

// PATCH /automacoes/:id — { ativa?, configuracao? }
router.patch('/automacoes/:id', async (req, res) => {
  const camposPermitidos = ['ativa', 'configuracao'];
  const atualizacoes = {};
  for (const campo of camposPermitidos) {
    if (req.body[campo] !== undefined) atualizacoes[campo] = req.body[campo];
  }

  const { data, error } = await req.supabase
    .from('automacoes')
    .update(atualizacoes)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

module.exports = router;
