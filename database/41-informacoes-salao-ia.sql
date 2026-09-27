-- ============================================================
-- SalonOS — Migração 41: informações do salão pra IA do WhatsApp
-- Rodar depois de 40.
--
-- Pedido do David (26/09/2026): a IA inventou "estacionamento gratuito ao
-- lado" num teste real, porque não tinha essa informação. Agora o salão
-- preenche em Config (salon-v6.html) e a IA responde com o que está aqui
-- -- e o que ficar em branco ela diz que confirma com a equipe.
-- NULL = não informado (diferente de "não tem").
-- ============================================================

alter table estabelecimentos add column if not exists estacionamento text
  check (estacionamento in ('nao_tem', 'gratuito', 'pago', 'conveniado', 'rua'));
alter table estabelecimentos add column if not exists manobrista boolean;
-- Texto livre pra outras perguntas comuns (wi-fi, acessibilidade, ponto
-- de referência, pet friendly...). Vai pro prompt da IA como está.
alter table estabelecimentos add column if not exists info_extra_ia text;
