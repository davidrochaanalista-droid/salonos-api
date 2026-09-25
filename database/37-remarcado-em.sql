-- ============================================================
-- SalonOS — Migração 37: rastreio de remarcação de agendamento
-- Rodar depois de 36.
--
-- Pedido do David: métricas de conta no painel-admin incluindo
-- "clientes remarcados". Achado ao implementar: o sistema nunca guardou
-- isso -- remarcar hoje é só um PATCH que sobrescreve inicio/fim na
-- mesma linha de agendamentos, sem histórico nenhum. Não dá pra
-- reconstruir o passado, então essa coluna só conta remarcações a partir
-- de agora (PATCH /agendamentos/:id, src/routes/agenda.js).
-- ============================================================

alter table agendamentos add column if not exists remarcado_em timestamptz;
