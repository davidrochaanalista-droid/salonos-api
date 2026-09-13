-- ============================================================
-- SalonOS — Migração 11: habilita Supabase Realtime em caixa_entradas
-- Objetivo: o "ao vivo" do caixa no painel operacional (salon-v6.html)
-- vira uma subscription real via supabase-js (postgres_changes) em vez
-- do setInterval simulado. Realtime lê o WAL diretamente -- não depende
-- do trigger trg_caixa_notify/pg_notify da migração 05 (que continua
-- existindo, sem uso hoje, mas inofensivo).
-- ============================================================

alter publication supabase_realtime add table caixa_entradas;
