/**
 * SalonOS — Confirmação de solicitação de agendamento
 * =======================================================
 * Extraído de src/routes/solicitacoes-agendamento.js pra ser
 * reaproveitado em 4 lugares: a rota HTTP /aceitar (equipe, painel),
 * a rota em lote /grupo/:grupoId/aceitar (equipe aceitando várias de
 * uma vez), e o webhook do WhatsApp (cliente aceitando uma proposta,
 * tanto no caminho salão-fechado quanto no caminho salão-aberto/
 * busca automática). Recebe o client Supabase por parâmetro (req.supabase
 * escopado por usuário no painel, service_role no webhook), mesmo
 * padrão de buscarConflitoAgendamento.
 */

const { buscarConflitoAgendamento } = require('./disponibilidade');

// Recheca conflito (a checagem anterior, se houve, pode estar
// desatualizada -- outro agendamento pode ter entrado nesse meio-tempo),
// cria o agendamento de verdade e marca a solicitação como confirmada.
// Nunca cria em cima de conflito -- devolve { ok:false, motivo, conflito }
// nesse caso, pra quem chamou decidir como avisar (painel devolve 409,
// webhook devolve uma mensagem natural pro cliente).
async function confirmarSolicitacaoAgendamento(supabaseClient, { solicitacaoId }) {
  const { data: solicitacao, error: errBusca } = await supabaseClient
    .from('solicitacoes_agendamento')
    .select('*, clientes(nome, telefone), estabelecimento_atividades(nome, duracao_min), profissionais(nome)')
    .eq('id', solicitacaoId)
    .single();
  if (errBusca || !solicitacao) return { ok: false, motivo: 'Solicitação não encontrada.' };

  if (solicitacao.status !== 'pendente' && solicitacao.status !== 'horario_proposto') {
    return { ok: false, motivo: 'Essa solicitação já foi respondida.' };
  }

  const dataHora = solicitacao.data_hora_proposta || solicitacao.data_hora_solicitada;
  if (!dataHora) {
    return { ok: false, motivo: 'Essa solicitação não tem um horário claro pra aceitar direto -- proponha um horário certo primeiro.' };
  }

  const duracaoMin = solicitacao.estabelecimento_atividades?.duracao_min || 60;
  const inicio = new Date(dataHora);
  const fim = new Date(inicio.getTime() + duracaoMin * 60000);

  if (solicitacao.profissional_id) {
    const conflito = await buscarConflitoAgendamento(supabaseClient, { profissionalId: solicitacao.profissional_id, inicio: inicio.toISOString(), fim: fim.toISOString() });
    if (conflito) {
      return {
        ok: false,
        motivo: `${solicitacao.profissionais?.nome || 'A profissional'} já tem um atendimento nesse horário (com ${conflito.clientes?.nome || 'outra cliente'}).`,
        conflito: true,
      };
    }
  }

  const { data: agendamento, error: errAgendamento } = await supabaseClient
    .from('agendamentos')
    .insert({
      estabelecimento_id: solicitacao.estabelecimento_id,
      cliente_id: solicitacao.cliente_id,
      profissional_id: solicitacao.profissional_id,
      estabelecimento_atividade_id: solicitacao.estabelecimento_atividade_id,
      inicio: inicio.toISOString(),
      fim: fim.toISOString(),
      origem: 'whatsapp',
      observacao: 'Solicitado via agendamento self-service/fora do horário.',
    })
    .select()
    .single();
  if (errAgendamento) return { ok: false, motivo: errAgendamento.message };

  const { error: errUpdate } = await supabaseClient
    .from('solicitacoes_agendamento')
    .update({ status: 'confirmado', agendamento_id: agendamento.id })
    .eq('id', solicitacaoId);
  if (errUpdate) return { ok: false, motivo: errUpdate.message };

  return { ok: true, agendamento, solicitacao };
}

module.exports = { confirmarSolicitacaoAgendamento };
