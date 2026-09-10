-- ============================================================
-- SalonOS — Migração 06: Desativar segmentos de saúde regulada
-- Rodar depois de 04-catalogo-completo-segmentos.sql
--
-- Decisão consciente (README-fase1.md, "Decisão 6"): por enquanto,
-- NÃO vender para Nutricionista, Psicologia, Odontologia e
-- Fisioterapia — são serviços de saúde regulados por conselho
-- profissional, geram prontuário clínico, e a LGPD trata dado de
-- saúde como categoria sensível (Art. 11) com exigência de base
-- legal mais restrita. O SalonOS hoje só cobre agendamento simples,
-- não substitui prontuário. Foco em beleza/estética/bem-estar até a
-- base estar mais madura para decidir se vale investir nesse gap.
--
-- Isso é reversível: quando/se decidir vender para esses segmentos,
-- basta rodar `update segmentos set ativo = true where slug in (...)`.
-- ============================================================

alter table segmentos add column if not exists ativo boolean not null default true;

update segmentos set ativo = false
where slug in ('nutricionista', 'psicologia', 'odontologia', 'fisioterapia');
