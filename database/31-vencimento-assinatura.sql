-- ============================================================
-- SalonOS — Vencimento de assinatura (data manual + aviso)
-- ============================================================
-- vencimento_em é definido manualmente pelo admin (não existe cobrança
-- recorrente automática ainda). vencimento_lembrete_enviado_dias guarda
-- o último limiar (7/3/1/0 dias) já avisado por WhatsApp pra essa data
-- -- evita reenviar a cada checagem do scheduler; é resetado sempre que
-- vencimento_em muda (ver PATCH /admin/contas/:id).

alter table estabelecimentos add column if not exists vencimento_em date;
alter table estabelecimentos add column if not exists vencimento_lembrete_enviado_dias int;
