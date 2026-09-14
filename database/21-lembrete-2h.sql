-- ============================================================
-- SalonOS — Migração 21: automação "Lembrete 2h antes"
-- Segundo lembrete de WhatsApp, mais perto do horário do que a
-- confirmação 24h -- reduz falta sem aviso (no-show). Mesmo padrão da
-- confirmacao_24h (ver src/lib/automacoes/scheduler.js), só muda a
-- janela de tempo.
-- ============================================================

alter table automacoes drop constraint automacoes_tipo_check;
alter table automacoes add constraint automacoes_tipo_check check (tipo in (
  'confirmacao_24h', 'lembrete_2h', 'reativacao_clientes', 'aniversario',
  'avaliacao_pos_atendimento', 'retorno_ciclo', 'upsell_agendamento',
  'lista_espera'
));
