/**
 * SalonOS — Marcação automática de no-show
 * ===========================================
 * Agendamento que passou do horário (fim) sem check-in/confirmação
 * ficava 'agendado'/'confirmado' pra sempre — essa checagem periódica
 * fecha esse gap chamando marcar_agendamentos_no_show() (Postgres, ver
 * database/33-no-show-automatico.sql), que marca como 'nao_compareceu'
 * e calcula (sem cobrar) a taxa de no-show se o estabelecimento tiver
 * taxa_no_show_pct configurada. Roda como processo de fundo
 * (service_role, sem usuário logado — mesmo padrão de
 * lembretesAssinatura.js/automacoes/scheduler.js).
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Housekeeping de status, não notificação em tempo real -- não precisa da
// granularidade de 15min do motor de automações de cliente.
const INTERVALO_MS = 60 * 60 * 1000;
const TOLERANCIA_HORAS_PADRAO = 2;

async function verificarNoShows() {
  const { data, error } = await supabase.rpc('marcar_agendamentos_no_show', { p_tolerancia_horas: TOLERANCIA_HORAS_PADRAO });
  if (error) {
    console.error('Falha ao marcar agendamentos como no-show:', error.message);
    return;
  }
  if (data > 0) console.log(`${data} agendamento(s) marcado(s) como não compareceu.`);
}

function iniciarSchedulerNoShow() {
  // Roda uma vez assim que o servidor sobe, além do intervalo -- mesmo
  // motivo já corrigido nos outros 2 schedulers do projeto (ver
  // CLAUDE.md item 13, 17/09/2026): sem isso, todo restart abre uma
  // janela morta de até 1h sem nenhuma checagem.
  verificarNoShows();
  setInterval(() => verificarNoShows().catch((erro) => console.error('Falha em verificarNoShows:', erro)), INTERVALO_MS);
}

module.exports = { iniciarSchedulerNoShow, verificarNoShows };
