/**
 * SalonOS — Motor de automações (checagens periódicas)
 * =======================================================
 * Roda como processo de fundo (service_role, sem usuário logado — mesmo
 * padrão de routes/whatsapp.js e routes/avaliacoes.js), varrendo TODOS
 * os estabelecimentos de uma vez por tipo de automação, não um a um.
 *
 * As automações "upsell_agendamento" e "lista_espera" NÃO passam por
 * aqui -- são gatilhos inline (reação imediata a um evento), ver
 * routes/agenda.js.
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const INTERVALO_MS = 15 * 60 * 1000;
const DIAS_INATIVIDADE_PADRAO = 45;
const JANELA_DEDUPE_ANIVERSARIO_DIAS = 350; // <365 de propósito: evita perder o disparo por 1 dia de fuso/atraso do scheduler

async function jaDisparou(automacaoId, clienteId, referenciaId, desde) {
  let consulta = supabase
    .from('automacao_disparos')
    .select('id')
    .eq('automacao_id', automacaoId)
    .eq('cliente_id', clienteId);

  consulta = referenciaId ? consulta.eq('referencia_id', referenciaId) : consulta.is('referencia_id', null);
  if (desde) consulta = consulta.gte('disparado_em', desde.toISOString());

  const { data } = await consulta.limit(1);
  return !!(data && data.length);
}

async function registrarDisparo({ automacaoId, estabelecimentoId, clienteId, referenciaId }) {
  await supabase.from('automacao_disparos').insert({
    automacao_id: automacaoId,
    estabelecimento_id: estabelecimentoId,
    cliente_id: clienteId,
    referencia_id: referenciaId || null,
  });
}

async function enviar({ automacaoId, estabelecimentoId, clienteId, referenciaId, telefone, texto }) {
  if (!telefone) return;
  const { enviarMensagemWhatsApp } = require('../../routes/whatsapp');
  await enviarMensagemWhatsApp({ telefone, texto });
  await registrarDisparo({ automacaoId, estabelecimentoId, clienteId, referenciaId });
}

async function automacoesAtivasPorTipo(tipo) {
  const { data, error } = await supabase
    .from('automacoes')
    .select('id, estabelecimento_id, configuracao, estabelecimentos(nome)')
    .eq('tipo', tipo)
    .eq('ativa', true);
  if (error) {
    console.error(`Falha ao buscar automações ativas (${tipo}):`, error.message);
    return [];
  }
  return data || [];
}

// ── 1. Confirmação 24h antes ──
async function verificarConfirmacao24h() {
  const automacoes = await automacoesAtivasPorTipo('confirmacao_24h');
  if (!automacoes.length) return;

  const agora = new Date();
  const de = new Date(agora.getTime() + 23 * 3600 * 1000);
  const ate = new Date(agora.getTime() + 25 * 3600 * 1000);

  for (const automacao of automacoes) {
    const { data: agendamentos } = await supabase
      .from('agendamentos')
      .select('id, inicio, cliente_id, clientes(nome, telefone), estabelecimento_atividades(nome)')
      .eq('estabelecimento_id', automacao.estabelecimento_id)
      .in('status', ['agendado', 'confirmado'])
      .gte('inicio', de.toISOString())
      .lte('inicio', ate.toISOString());

    for (const ag of agendamentos || []) {
      if (await jaDisparou(automacao.id, ag.cliente_id, ag.id)) continue;
      const telefone = ag.clientes?.telefone;
      const hora = new Date(ag.inicio).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const nomeEstabelecimento = automacao.estabelecimentos?.nome || 'seu horário';
      const servico = ag.estabelecimento_atividades?.nome || 'seu atendimento';
      const texto = `Oi, ${ag.clientes?.nome || 'tudo bem'}? Passando pra lembrar do seu horário amanhã às ${hora} (${servico}) no ${nomeEstabelecimento}. Te esperamos!`;
      await enviar({ automacaoId: automacao.id, estabelecimentoId: automacao.estabelecimento_id, clienteId: ag.cliente_id, referenciaId: ag.id, telefone, texto });
    }
  }
}

// ── 2. Reativar clientes sumidos ──
async function verificarReativacao() {
  const automacoes = await automacoesAtivasPorTipo('reativacao_clientes');
  if (!automacoes.length) return;

  for (const automacao of automacoes) {
    const diasInatividade = automacao.configuracao?.dias_inatividade || DIAS_INATIVIDADE_PADRAO;
    const limite = new Date(Date.now() - diasInatividade * 24 * 3600 * 1000);

    const { data: clientes } = await supabase
      .from('clientes')
      .select('id, nome, telefone')
      .eq('estabelecimento_id', automacao.estabelecimento_id);

    for (const cliente of clientes || []) {
      const { data: ultimoAtendimento } = await supabase
        .from('atendimentos')
        .select('data_atendimento')
        .eq('cliente_id', cliente.id)
        .order('data_atendimento', { ascending: false })
        .limit(1)
        .maybeSingle();

      // Sem histórico de atendimento ainda -- cliente novo, não "sumido".
      if (!ultimoAtendimento || new Date(ultimoAtendimento.data_atendimento) > limite) continue;
      if (await jaDisparou(automacao.id, cliente.id, null, new Date(Date.now() - diasInatividade * 24 * 3600 * 1000))) continue;

      const nomeEstabelecimento = automacao.estabelecimentos?.nome || 'a gente';
      const texto = `Oi, ${cliente.nome || 'tudo bem'}? Faz tempo que você não aparece no ${nomeEstabelecimento} -- que tal agendar um horário? Temos vaga essa semana!`;
      await enviar({ automacaoId: automacao.id, estabelecimentoId: automacao.estabelecimento_id, clienteId: cliente.id, referenciaId: null, telefone: cliente.telefone, texto });
    }
  }
}

// ── 3. Oferta de aniversário ──
async function verificarAniversario() {
  const automacoes = await automacoesAtivasPorTipo('aniversario');
  if (!automacoes.length) return;

  const hoje = new Date();

  for (const automacao of automacoes) {
    const { data: clientes } = await supabase
      .from('clientes')
      .select('id, nome, telefone, data_nascimento')
      .eq('estabelecimento_id', automacao.estabelecimento_id)
      .not('data_nascimento', 'is', null);

    for (const cliente of clientes || []) {
      // Comparar mês/dia em JS -- filtrar por extract(month/day) via
      // PostgREST não é direto, e o volume por estabelecimento é pequeno.
      const nasc = new Date(cliente.data_nascimento + 'T00:00:00');
      if (nasc.getMonth() !== hoje.getMonth() || nasc.getDate() !== hoje.getDate()) continue;

      const desde = new Date(Date.now() - JANELA_DEDUPE_ANIVERSARIO_DIAS * 24 * 3600 * 1000);
      if (await jaDisparou(automacao.id, cliente.id, null, desde)) continue;

      const nomeEstabelecimento = automacao.estabelecimentos?.nome || 'toda a equipe';
      const texto = `Parabéns, ${cliente.nome || 'você'}! 🎉 Todo mundo aqui do ${nomeEstabelecimento} deseja um feliz aniversário. Que tal comemorar com um horário especial essa semana?`;
      await enviar({ automacaoId: automacao.id, estabelecimentoId: automacao.estabelecimento_id, clienteId: cliente.id, referenciaId: null, telefone: cliente.telefone, texto });
    }
  }
}

// ── 4. Retorno por ciclo (por serviço) ──
async function verificarRetornoCiclo() {
  const automacoes = await automacoesAtivasPorTipo('retorno_ciclo');
  if (!automacoes.length) return;

  for (const automacao of automacoes) {
    const { data: atividades } = await supabase
      .from('estabelecimento_atividades')
      .select('id, nome, ciclo_recompra_dias')
      .eq('estabelecimento_id', automacao.estabelecimento_id)
      .not('ciclo_recompra_dias', 'is', null);

    for (const atividade of atividades || []) {
      const limite = new Date(Date.now() - atividade.ciclo_recompra_dias * 24 * 3600 * 1000);

      const { data: atendimentos } = await supabase
        .from('atendimentos')
        .select('cliente_id, data_atendimento, clientes(nome, telefone)')
        .eq('estabelecimento_atividade_id', atividade.id)
        .order('data_atendimento', { ascending: false });

      // Fica só com o atendimento mais recente por cliente (a query já
      // vem ordenada desc, então o primeiro que aparece de cada cliente é o último).
      const ultimoPorCliente = new Map();
      for (const at of atendimentos || []) {
        if (!ultimoPorCliente.has(at.cliente_id)) ultimoPorCliente.set(at.cliente_id, at);
      }

      for (const [clienteId, at] of ultimoPorCliente) {
        if (new Date(at.data_atendimento) > limite) continue;
        const desde = new Date(Date.now() - atividade.ciclo_recompra_dias * 24 * 3600 * 1000);
        if (await jaDisparou(automacao.id, clienteId, atividade.id, desde)) continue;

        const texto = `Oi, ${at.clientes?.nome || 'tudo bem'}? Já faz um tempinho desde seu(sua) ${atividade.nome} -- essa é a época certa de repetir! Quer agendar?`;
        await enviar({ automacaoId: automacao.id, estabelecimentoId: automacao.estabelecimento_id, clienteId, referenciaId: atividade.id, telefone: at.clientes?.telefone, texto });
      }
    }
  }
}

async function rodarTodasAutomacoes() {
  await verificarConfirmacao24h().catch(erro => console.error('Falha em verificarConfirmacao24h:', erro));
  await verificarReativacao().catch(erro => console.error('Falha em verificarReativacao:', erro));
  await verificarAniversario().catch(erro => console.error('Falha em verificarAniversario:', erro));
  await verificarRetornoCiclo().catch(erro => console.error('Falha em verificarRetornoCiclo:', erro));
}

function iniciarScheduler() {
  setInterval(() => rodarTodasAutomacoes(), INTERVALO_MS);
}

module.exports = {
  iniciarScheduler,
  rodarTodasAutomacoes,
  verificarConfirmacao24h,
  verificarReativacao,
  verificarAniversario,
  verificarRetornoCiclo,
};
