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

// Usado nos pontos onde um humano digita a data/hora à mão (criar/editar
// agendamento no painel, propor horário pra uma solicitação) -- a busca
// automática de horário (buscarHorariosDisponiveis) já filtra o passado
// sozinha (ver instanteEmSaoPaulo abaixo), não precisa dessa checagem.
function estaNoPassado(dataHoraIso) {
  const instante = new Date(dataHoraIso).getTime();
  return !Number.isNaN(instante) && instante < Date.now();
}

const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const GRADE_MINUTOS = 15;

function horaParaMinutos(hora) {
  const [h, m] = (hora || '00:00').split(':').map(Number);
  return h * 60 + m;
}

// Verdadeiro se [inicioA,fimA) e [inicioB,fimB) se sobrepõem.
function seSobrepoe(inicioA, fimA, inicioB, fimB) {
  return inicioA < fimB && fimA > inicioB;
}

// Data de hoje (YYYY-MM-DD) no fuso de Brasília -- o servidor (Railway)
// não necessariamente roda nesse fuso, mesmo cuidado já tomado em
// estaAberto()/saudacaoPorHorario() em whatsapp.js.
function hojeEmSaoPaulo() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

// Constrói o instante UTC (em ms) correspondente a `horaMin` minutos
// desde a meia-noite de {ano,mes,dia}, em Brasília. Brasil suspendeu o
// horário de verão desde 2019 -- offset fixo -03:00 é seguro e evita
// depender do fuso local do processo Node (novamente, Railway pode não
// estar em horário do Brasil).
function instanteEmSaoPaulo(ano, mes, dia, horaMin) {
  const hh = String(Math.floor(horaMin / 60)).padStart(2, '0');
  const mm = String(horaMin % 60).padStart(2, '0');
  return new Date(`${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}T${hh}:${mm}:00-03:00`).getTime();
}

// Busca até `maxPropostas` combinações de horário/profissional que
// encaixam TODOS os serviços pedidos, em sequência, na mesma visita
// (serviço 2 começa quando o serviço 1 termina, etc.) -- não em
// paralelo. Sem tabela de especialidade profissional↔serviço hoje,
// então qualquer profissional ativo pode fazer qualquer serviço,
// mesma regra já usada no resto do sistema.
//
// Pré-busca os agendamentos do dia inteiro (todos os profissionais)
// numa única query por dia candidato, em vez de checar conflito
// profissional-a-profissional/horário-a-horário -- essencial pra não
// explodir em round-trips numa varredura de vários dias.
async function buscarHorariosDisponiveis(supabaseClient, {
  estabelecimentoId, servicos, dataPreferida, janelaDias = 7, maxPropostas = 3,
}) {
  if (!servicos?.length) return [];

  const { data: estabelecimento, error: errEst } = await supabaseClient
    .from('estabelecimentos')
    .select('horario_abertura, horario_fechamento, dias_funcionamento')
    .eq('id', estabelecimentoId)
    .single();
  if (errEst || !estabelecimento) throw errEst || new Error('Estabelecimento não encontrado.');

  const { data: profissionais, error: errProf } = await supabaseClient
    .from('profissionais')
    .select('id')
    .eq('estabelecimento_id', estabelecimentoId)
    .eq('ativo', true);
  if (errProf) throw errProf;
  if (!profissionais?.length) return [];
  const idsProfissionaisArray = profissionais.map(p => p.id);
  const idsProfissionaisAtivos = new Set(idsProfissionaisArray);

  const abreMin = horaParaMinutos(estabelecimento.horario_abertura);
  const fechaMin = horaParaMinutos(estabelecimento.horario_fechamento);
  const duracaoTotal = servicos.reduce((soma, s) => soma + s.duracaoMin, 0);

  const propostas = [];
  // Âncora de calendário em UTC puro (Date.UTC), só pra aritmética de dia
  // -- nunca usada como instante real. getUTCDay() sobre essa âncora dá o
  // dia da semana certo pra qualquer data civil, sem depender do fuso do
  // processo Node.
  const [anoBase, mesBase, diaBase] = (dataPreferida || hojeEmSaoPaulo()).split('-').map(Number);
  const anchorBase = Date.UTC(anoBase, mesBase - 1, diaBase);

  for (let offsetDia = 0; offsetDia < janelaDias && propostas.length < maxPropostas; offsetDia++) {
    const anchorDia = new Date(anchorBase + offsetDia * 86400000);
    const ano = anchorDia.getUTCFullYear();
    const mes = anchorDia.getUTCMonth() + 1;
    const dia = anchorDia.getUTCDate();
    if (!estabelecimento.dias_funcionamento?.includes(DIAS_SEMANA[anchorDia.getUTCDay()])) continue;

    const inicioDiaMs = instanteEmSaoPaulo(ano, mes, dia, 0);
    const fimDiaMs = inicioDiaMs + 86400000;

    const { data: agendamentosDoDia, error: errAg } = await supabaseClient
      .from('agendamentos')
      .select('profissional_id, inicio, fim')
      .eq('estabelecimento_id', estabelecimentoId)
      .not('status', 'in', '(cancelado,nao_compareceu)')
      .lt('inicio', new Date(fimDiaMs).toISOString())
      .gt('fim', new Date(inicioDiaMs).toISOString());
    if (errAg) throw errAg;

    const ocupadosPorProfissional = new Map();
    for (const ag of agendamentosDoDia || []) {
      if (!ag.profissional_id) continue;
      if (!ocupadosPorProfissional.has(ag.profissional_id)) ocupadosPorProfissional.set(ag.profissional_id, []);
      ocupadosPorProfissional.get(ag.profissional_id).push({ inicio: new Date(ag.inicio).getTime(), fim: new Date(ag.fim).getTime() });
    }
    const profissionalLivre = (profissionalId, inicioMs, fimMs, reservadosNesteCandidato) => {
      const ocupados = ocupadosPorProfissional.get(profissionalId) || [];
      const emConflito = ocupados.some(o => seSobrepoe(inicioMs, fimMs, o.inicio, o.fim))
        || reservadosNesteCandidato.some(r => r.profissionalId === profissionalId && seSobrepoe(inicioMs, fimMs, r.inicio, r.fim));
      return !emConflito;
    };

    for (let minutoCandidato = abreMin; minutoCandidato + duracaoTotal <= fechaMin; minutoCandidato += GRADE_MINUTOS) {
      // No dia de hoje, nunca propõe um horário que já passou -- sem essa
      // checagem, pedir às 15h com abertura 9h fazia o primeiro candidato
      // (09:00) passar mesmo já tendo acabado, e no caminho salão-aberto
      // isso chegava a auto-confirmar um agendamento no passado.
      if (instanteEmSaoPaulo(ano, mes, dia, minutoCandidato) < Date.now()) continue;

      const itens = [];
      let cursorMin = minutoCandidato;
      let falhou = false;

      for (const servico of servicos) {
        const inicioMs = instanteEmSaoPaulo(ano, mes, dia, cursorMin);
        const fimMs = inicioMs + servico.duracaoMin * 60000;

        // Preferência de profissional é pra valer: se ela não estiver livre
        // NESSE horário candidato, o candidato falha (tenta o próximo
        // horário da grade) -- nunca substitui silenciosamente por outra
        // profissional só porque a primeira preferida do dia estava ocupada.
        // Só cai pra "qualquer uma livre" quando não há preferência.
        const profissionalEscolhido = servico.profissionalPreferidoId
          ? (idsProfissionaisAtivos.has(servico.profissionalPreferidoId) && profissionalLivre(servico.profissionalPreferidoId, inicioMs, fimMs, itens) ? servico.profissionalPreferidoId : null)
          : (idsProfissionaisArray.find(id => profissionalLivre(id, inicioMs, fimMs, itens)) || null);

        if (!profissionalEscolhido) { falhou = true; break; }

        itens.push({
          estabelecimento_atividade_id: servico.estabelecimentoAtividadeId,
          profissional_id: profissionalEscolhido,
          inicio: inicioMs,
          fim: fimMs,
          profissionalId: profissionalEscolhido,
        });
        cursorMin += servico.duracaoMin;
      }

      if (!falhou) {
        propostas.push({
          data: `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`,
          itens: itens.map(i => ({
            estabelecimento_atividade_id: i.estabelecimento_atividade_id,
            profissional_id: i.profissional_id,
            inicio: new Date(i.inicio).toISOString(),
            fim: new Date(i.fim).toISOString(),
          })),
        });
        if (propostas.length >= maxPropostas) break;
      }
    }
  }

  return propostas;
}

module.exports = { buscarConflitoAgendamento, buscarHorariosDisponiveis, estaNoPassado };
