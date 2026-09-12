-- ============================================================
-- SalonOS — Migração 09: nome do segmento "Cabeleireiro" mais neutro
-- Feedback do usuário testando o cadastro real (11/09/2026): "cabeleireiro,
-- mas não tem cabeleireira".
-- ============================================================

update segmentos set nome = 'Cabeleireiro(a) / Salão de Beleza' where slug = 'cabeleireiro';
