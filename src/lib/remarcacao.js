/**
 * SalonOS — Remarcação de agendamento pelo WhatsApp, com sinal
 * ==============================================================
 * Pedido do David (26/09/2026), ver database/39-comprovante-pagamento-antecipado.sql:
 * remarcar exige um sinal (30% do preço -- a IA só fala o VALOR em reais,
 * nunca a porcentagem) e NÃO passa pela equipe: pagou o sinal e o novo
 * horário está livre, a própria IA move o agendamento.
 *
 *   1. solicitarRemarcacao  -- ferramenta solicitar_remarcacao: calcula e
 *      grava o sinal pedido (a IA informa o valor e manda o Pix);
 *   2. comprovante com valor >= sinal marca sinal_remarcacao_pago_em
 *      (src/lib/comprovantes.js);
 *   3. remarcarAgendamento  -- ferramenta remarcar_agendamento: só com
 *      sinal pago; move o PRÓPRIO agendamento (nunca cria outro, senão o
 *      horário antigo ficaria ocupado) se o novo horário estiver dentro do
 *      funcionamento e sem conflito; senão devolve alternativas livres.
 *
 * Todas as funções conferem que o agendamento é DESTE cliente/salão --
 * o id vem da IA, nunca é confiável por si só.
 */

const { buscarConflitoAgendamento, buscarHorariosDisponiveis, estaNoPassado } = require('./disponibilidade');

const PERCENTUAL_SINAL_REMARCACAO = 0.30;
const FUSO = 'America/Sao_Paulo';
const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];

// 30% do preço, arredondado pra cima no centavo (nunca cobra menos que o
// percentual). null se o serviço não tem preço cadastrado.
function valorSinalRemarcacao(preco) {
  const p = Number(preco);
  if (!Number.isFinite(p) || p <= 0) return null;
  return Math.ceil(p * PERCENTUAL_SINAL_REMARCACAO * 100) / 100;
}

const reais = (valor) => `R$ ${Number(valor).toFixed(2).replace('.', ',')}`;
const formatarQuando = (iso) => new Date(iso).toLocaleString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: FUSO });

// A IA manda "YYYY-MM-DDTHH:MM:SS" no horário de Brasília, às vezes sem
// fuso -- sem fuso, assume -03:00 (Brasil não tem horário de verão desde 2019).
function interpretarDataHoraBrasilia(texto) {
  if (!texto) return null;
  const temFuso = /([+-]\d{2}:?\d{2}|Z)$/.test(texto);
  const data = new Date(temFuso ? texto : `${texto.length === 16 ? texto + ':00' : texto}-03:00`);
  return Number.isNaN(data.getTime()) ? null : data;
}

function partesEmSaoPaulo(data) {
  const partes = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: FUSO, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(data).map(p => [p.type, p.value]));
  const diaSemana = { Sun: 'dom', Mon: 'seg', Tue: 'ter', Wed: 'qua', Thu: 'qui', Fri: 'sex', Sat: 'sab' }[partes.weekday];
  return { diaSemana, minutos: (Number(partes.hour) % 24) * 60 + Number(partes.minute), dataIso: `${partes.year}-${partes.month}-${partes.day}` };
}

const horaParaMinutos = (hora) => {
  const [h, m] = String(hora || '00:00').split(':').map(Number);
  return h * 60 + (m || 0);
};

async function carregarAgendamentoDoCliente(supabase, { estabelecimentoId, clienteId, agendamentoId }) {
  if (!agendamentoId) return null;
  const { data } = await supabase
    .from('agendamentos')
    .select('id, inicio, fim, status, profissional_id, estabelecimento_atividade_id, remarcacao_solicitada_em, sinal_remarcacao_valor, sinal_remarcacao_pago_em, estabelecimento_atividades(nome, preco)')
    .eq('id', agendamentoId)
    .eq('estabelecimento_id', estabelecimentoId)
    .eq('cliente_id', clienteId)
    .maybeSingle();
  if (!data || !['agendado', 'confirmado'].includes(data.status) || new Date(data.inicio) < new Date()) return null;
  return data;
}

// Ferramenta solicitar_remarcacao.
async function solicitarRemarcacao(supabase, { estabelecimentoId, clienteId, agendamentoId }) {
  const ag = await carregarAgendamentoDoCliente(supabase, { estabelecimentoId, clienteId, agendamentoId });
  if (!ag) return { ok: false, motivo: 'agendamento não encontrado entre os próximos agendamentos deste cliente' };
  if (ag.sinal_remarcacao_pago_em) {
    return { ok: true, sinal_ja_pago: true, instrucao: 'O sinal já está pago: pergunte o novo dia/horário e use remarcar_agendamento.' };
  }

  const sinal = valorSinalRemarcacao(ag.estabelecimento_atividades?.preco);
  if (sinal == null) return { ok: false, motivo: 'serviço sem preço cadastrado -- a equipe combina o valor do sinal com o cliente' };

  const { error } = await supabase.from('agendamentos')
    .update({ remarcacao_solicitada_em: new Date().toISOString(), sinal_remarcacao_valor: sinal })
    .eq('id', ag.id);
  if (error) return { ok: false, motivo: error.message };

  return { ok: true, sinal_ja_pago: false, valor_sinal: reais(sinal), instrucao: 'Informe o valor com gentileza (nunca a porcentagem) e, se o cliente topar, mande o Pix com enviar_chave_pix e peça o comprovante.' };
}

// Ferramenta remarcar_agendamento.
async function remarcarAgendamento(supabase, { estabelecimentoId, clienteId, agendamentoId, novaDataHora, profissionalId, profissionaisAtivos = [] }) {
  const ag = await carregarAgendamentoDoCliente(supabase, { estabelecimentoId, clienteId, agendamentoId });
  if (!ag) return { ok: false, motivo: 'agendamento não encontrado entre os próximos agendamentos deste cliente' };
  if (!ag.sinal_remarcacao_pago_em) {
    return { ok: false, motivo: 'o sinal de remarcação ainda não foi pago -- use solicitar_remarcacao e espere o comprovante; nunca remarque sem o sinal' };
  }

  const novoInicio = interpretarDataHoraBrasilia(novaDataHora);
  if (!novoInicio) return { ok: false, motivo: 'data/hora inválida -- use YYYY-MM-DDTHH:MM:SS no horário de Brasília' };
  if (estaNoPassado(novoInicio.toISOString())) return { ok: false, motivo: 'esse horário já passou' };

  const duracaoMs = new Date(ag.fim) - new Date(ag.inicio);
  const novoFim = new Date(novoInicio.getTime() + duracaoMs);

  // Troca de profissional só vale se for um profissional ativo do salão
  // (vem de uma alternativa devolvida por esta mesma função).
  const profissionalFinal = profissionalId && profissionaisAtivos.some(p => p.id === profissionalId) ? profissionalId : ag.profissional_id;

  const { data: estabelecimento } = await supabase
    .from('estabelecimentos')
    .select('horario_abertura, horario_fechamento, dias_funcionamento')
    .eq('id', estabelecimentoId)
    .single();

  const inicioSp = partesEmSaoPaulo(novoInicio);
  const fimSp = partesEmSaoPaulo(novoFim);
  const dentroDoFuncionamento = !!estabelecimento
    && (estabelecimento.dias_funcionamento || []).includes(inicioSp.diaSemana)
    && inicioSp.dataIso === fimSp.dataIso
    && inicioSp.minutos >= horaParaMinutos(estabelecimento.horario_abertura)
    && fimSp.minutos <= horaParaMinutos(estabelecimento.horario_fechamento);

  const conflito = dentroDoFuncionamento
    ? await buscarConflitoAgendamento(supabase, { profissionalId: profissionalFinal, inicio: novoInicio.toISOString(), fim: novoFim.toISOString(), ignorarAgendamentoId: ag.id })
    : null;

  if (!dentroDoFuncionamento || conflito) {
    const alternativas = await buscarAlternativas(supabase, { estabelecimentoId, ag, duracaoMs, dataPreferida: inicioSp.dataIso, profissionaisAtivos });
    return {
      ok: false,
      motivo: dentroDoFuncionamento ? 'esse horário já está ocupado' : 'fora do horário/dia de funcionamento',
      alternativas_livres: alternativas,
      instrucao: alternativas.length
        ? 'Ofereça essas alternativas com naturalidade; quando o cliente escolher, chame remarcar_agendamento de novo com a nova_data_hora (e o profissional_id da alternativa).'
        : 'Nenhum horário livre na semana a partir dessa data -- pergunte outra data de preferência.',
    };
  }

  const { error } = await supabase.from('agendamentos').update({
    inicio: novoInicio.toISOString(),
    fim: novoFim.toISOString(),
    profissional_id: profissionalFinal,
    remarcado_em: new Date().toISOString(),
    remarcacao_solicitada_em: null,
  }).eq('id', ag.id);
  if (error) return { ok: false, motivo: error.message };

  return {
    ok: true, remarcado: true, servico: ag.estabelecimento_atividades?.nome, novo_horario: formatarQuando(novoInicio),
    // Horário ANTIGO, agora livre -- quem chama oferece pra lista de espera
    // (src/lib/lista-espera.js) e tira esse campo antes de devolver pra IA.
    vaga_liberada: {
      estabelecimento_id: estabelecimentoId, cliente_id: clienteId, estabelecimento_atividade_id: ag.estabelecimento_atividade_id,
      profissional_id: ag.profissional_id, inicio: ag.inicio, fim: ag.fim,
    },
  };
}

async function buscarAlternativas(supabase, { estabelecimentoId, ag, duracaoMs, dataPreferida, profissionaisAtivos }) {
  const servico = { estabelecimentoAtividadeId: ag.estabelecimento_atividade_id, duracaoMin: Math.round(duracaoMs / 60000) };
  try {
    // Primeiro com o mesmo profissional; se não houver, qualquer um livre.
    let propostas = ag.profissional_id
      ? await buscarHorariosDisponiveis(supabase, { estabelecimentoId, servicos: [{ ...servico, profissionalPreferidoId: ag.profissional_id }], dataPreferida })
      : [];
    if (!propostas.length) propostas = await buscarHorariosDisponiveis(supabase, { estabelecimentoId, servicos: [servico], dataPreferida });

    return propostas.map(p => {
      const item = p.itens[0];
      const nome = profissionaisAtivos.find(pr => pr.id === item.profissional_id)?.nome;
      return {
        nova_data_hora: new Date(item.inicio).toLocaleString('sv-SE', { timeZone: FUSO }).replace(' ', 'T'),
        quando: formatarQuando(item.inicio),
        profissional_id: item.profissional_id,
        profissional: nome || null,
      };
    });
  } catch (erro) {
    console.error('Falha ao buscar alternativas de remarcação:', erro.message);
    return [];
  }
}

module.exports = { valorSinalRemarcacao, solicitarRemarcacao, remarcarAgendamento, interpretarDataHoraBrasilia, PERCENTUAL_SINAL_REMARCACAO };
