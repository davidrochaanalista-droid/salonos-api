-- ============================================================
-- SalonOS — Migração 17: conexão de WhatsApp por salão
-- Cada estabelecimento passa a ter sua própria instância no Evolution
-- API (nome determinístico "salon_{estabelecimento_id}", ver
-- src/lib/evolution-api.js) -- substitui a EVOLUTION_INSTANCE fixa do
-- .env, que só suportava um número pra toda a SalonOS.
-- whatsapp_status é atualizado pelo webhook (evento "connection.update"),
-- não pelo polling do front -- ver src/routes/whatsapp.js.
-- ============================================================

alter table estabelecimentos add column whatsapp_instancia text;
alter table estabelecimentos add column whatsapp_status text not null default 'desconectado'
  check (whatsapp_status in ('desconectado', 'conectando', 'conectado'));
alter table estabelecimentos add column whatsapp_numero text;
