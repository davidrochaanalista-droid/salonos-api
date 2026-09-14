/**
 * SalonOS — Checagem de conflito de agenda
 * ===========================================
 * Usado tanto pelo painel (aceitar/propor horário de uma solicitação,
 * src/routes/solicitacoes-agendamento.js) quanto pelo webhook do WhatsApp
 * (quando o cliente aceita uma proposta, src/routes/whatsapp.js) -- os
 * dois usam clientes Supabase diferentes (req.supabase escopado por
 * usuário vs. service_role no webhook), por isso recebe o client como
 * parâmetro em vez de importar um fixo.
 */

// Retorna o primeiro agendamento conflitante do profissional nesse
// intervalo, ou null se está livre (ou se não há profissional definido
// pra checar -- nesse caso não dá pra saber conflito específico).
async function buscarConflitoAgendamento(supabaseClient, { profissionalId, inicio, fim, ignorarAgendamentoId }) {
  if (!profissionalId) return null;

  let consulta = supabaseClient
    .from('agendamentos')
    .select('id, inicio, fim, clientes(nome)')
    .eq('profissional_id', profissionalId)
    .not('status', 'in', '(cancelado,nao_compareceu)')
    .lt('inicio', fim)
    .gt('fim', inicio);

  if (ignorarAgendamentoId) consulta = consulta.neq('id', ignorarAgendamentoId);

  const { data, error } = await consulta.limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

module.exports = { buscarConflitoAgendamento };
