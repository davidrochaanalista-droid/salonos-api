-- ============================================================
-- SalonOS — Migração 20: profissional na solicitação de agendamento
-- Cliente pode mencionar preferência de profissional ao pedir horário
-- fora do expediente (IA registra se mencionado, ver
-- registrar_solicitacao_agendamento em src/routes/whatsapp.js). Também
-- é usada pra checar conflito de agenda real antes de aceitar ou propor
-- um horário (ver src/routes/solicitacoes-agendamento.js).
-- ============================================================

alter table solicitacoes_agendamento add column profissional_id uuid references profissionais(id);
