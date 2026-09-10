-- ============================================================
-- SalonOS — Migração 04: Catálogo completo de segmentos
-- Rodar depois de 01-schema-fase1.sql e 03-migracao-onboarding-historico.sql
--
-- Cobre: os 8 segmentos que já existiam sem atividades cadastradas
-- (barbearia, manicure, esteticista, depilacao, massoterapia,
-- micropigmentacao, maquiagem, podologia) + 9 segmentos novos.
--
-- ATENÇÃO — leia antes de usar em produção:
-- Os segmentos marcados como [SAÚDE REGULADA] abaixo (nutricionista,
-- psicologia, odontologia, fisioterapia) envolvem dado de saúde, que
-- a LGPD trata como categoria SENSÍVEL (Art. 11), com exigências mais
-- rígidas que preferência estética. O catálogo aqui cobre só
-- AGENDAMENTO SIMPLES (nome do procedimento, duração, faixa de preço)
-- — não inclui prontuário clínico, odontograma, evolução de sessão,
-- diagnóstico ou qualquer registro clínico. Ver nota completa no
-- README-fase1.md antes de oferecer esses segmentos a um cliente real.
-- ============================================================

-- ── NOVOS SEGMENTOS ──
insert into segmentos (nome, slug, icone, ordem) values
  ('Tatuagem e Piercing', 'tatuagem_piercing', '🖋', 10),
  ('Bronzeamento Artificial', 'bronzeamento', '☀', 11),
  ('Extensão de Cílios e Sobrancelhas', 'cilios_extensao', '👁', 12),
  ('Nutricionista', 'nutricionista', '🥗', 13),
  ('Psicologia / Terapia', 'psicologia', '🧠', 14),
  ('Personal Trainer / Estúdio', 'personal_trainer', '🏋', 15),
  ('Terapias Holísticas', 'terapias_holisticas', '🕯', 16),
  ('Odontologia', 'odontologia', '🦷', 17),
  ('Fisioterapia', 'fisioterapia', '🩹', 18)
on conflict (slug) do nothing;

-- ============================================================
-- ATIVIDADES — segmentos que já existiam sem catálogo
-- ============================================================

-- Barbearia
insert into atividades_catalogo (segmento_id, nome, descricao_curta, duracao_padrao_min, preco_sugerido_min, preco_sugerido_max, ordem)
select id, 'Corte Masculino', 'Corte tradicional ou degradê', 40, 35, 70, 1 from segmentos where slug='barbearia'
union all select id, 'Barba', 'Aparar e desenhar a barba', 30, 25, 50, 2 from segmentos where slug='barbearia'
union all select id, 'Combo Corte + Barba', 'Corte e barba no mesmo atendimento', 60, 55, 100, 3 from segmentos where slug='barbearia'
union all select id, 'Corte Infantil', 'Corte para crianças', 30, 30, 55, 4 from segmentos where slug='barbearia'
union all select id, 'Sobrancelha Masculina', 'Design e aparo de sobrancelha', 15, 15, 30, 5 from segmentos where slug='barbearia'
union all select id, 'Pigmentação de Barba', 'Preenchimento de falhas com pigmento', 45, 60, 120, 6 from segmentos where slug='barbearia';

-- Manicure e Pedicure
insert into atividades_catalogo (segmento_id, nome, descricao_curta, duracao_padrao_min, preco_sugerido_min, preco_sugerido_max, ordem)
select id, 'Manicure Simples', 'Cutilagem e esmaltação tradicional', 40, 25, 45, 1 from segmentos where slug='manicure'
union all select id, 'Pedicure Simples', 'Cutilagem e esmaltação dos pés', 45, 30, 50, 2 from segmentos where slug='manicure'
union all select id, 'Combo Mani + Pedi', 'Mãos e pés no mesmo atendimento', 80, 50, 90, 3 from segmentos where slug='manicure'
union all select id, 'Esmaltação em Gel', 'Esmalte de longa duração', 60, 50, 90, 4 from segmentos where slug='manicure'
union all select id, 'Alongamento de Unhas', 'Fibra de vidro ou gel', 120, 100, 200, 5 from segmentos where slug='manicure'
union all select id, 'Nail Art', 'Desenhos e decorações personalizadas', 30, 15, 60, 6 from segmentos where slug='manicure';

-- Esteticista / Clínica de Estética
insert into atividades_catalogo (segmento_id, nome, descricao_curta, duracao_padrao_min, preco_sugerido_min, preco_sugerido_max, ordem)
select id, 'Limpeza de Pele', 'Higienização profunda facial', 60, 100, 180, 1 from segmentos where slug='esteticista'
union all select id, 'Peeling Químico', 'Renovação celular com ácidos', 45, 150, 350, 2 from segmentos where slug='esteticista'
union all select id, 'Microagulhamento', 'Estímulo de colágeno', 60, 200, 400, 3 from segmentos where slug='esteticista'
union all select id, 'Drenagem Linfática', 'Massagem para redução de inchaço', 60, 90, 160, 4 from segmentos where slug='esteticista'
union all select id, 'Radiofrequência Facial', 'Tratamento de firmeza da pele', 45, 150, 280, 5 from segmentos where slug='esteticista'
union all select id, 'Massagem Modeladora', 'Massagem para contorno corporal', 60, 100, 180, 6 from segmentos where slug='esteticista';

-- Depilação
insert into atividades_catalogo (segmento_id, nome, descricao_curta, duracao_padrao_min, preco_sugerido_min, preco_sugerido_max, ordem)
select id, 'Depilação Perna Completa', 'Cera quente ou morna', 40, 50, 90, 1 from segmentos where slug='depilacao'
union all select id, 'Depilação Axila', 'Cera quente ou morna', 15, 20, 35, 2 from segmentos where slug='depilacao'
union all select id, 'Depilação Buço', 'Cera ou linha', 10, 10, 20, 3 from segmentos where slug='depilacao'
union all select id, 'Depilação Íntima', 'Cera completa', 40, 60, 110, 4 from segmentos where slug='depilacao'
union all select id, 'Depilação Egípcia (linha)', 'Técnica com fio de linha', 20, 25, 45, 5 from segmentos where slug='depilacao'
union all select id, 'Depilação a Laser (sessão)', 'Sessão de depilação definitiva', 30, 80, 250, 6 from segmentos where slug='depilacao';

-- Massoterapia / Spa
insert into atividades_catalogo (segmento_id, nome, descricao_curta, duracao_padrao_min, preco_sugerido_min, preco_sugerido_max, ordem)
select id, 'Massagem Relaxante', 'Massagem corporal para alívio de tensão', 60, 100, 180, 1 from segmentos where slug='massoterapia'
union all select id, 'Massagem Terapêutica', 'Foco em pontos de dor e tensão muscular', 60, 120, 200, 2 from segmentos where slug='massoterapia'
union all select id, 'Massagem com Pedras Quentes', 'Terapia com pedras vulcânicas', 75, 150, 250, 3 from segmentos where slug='massoterapia'
union all select id, 'Reflexologia Podal', 'Massagem terapêutica nos pés', 45, 80, 140, 4 from segmentos where slug='massoterapia'
union all select id, 'Shiatsu', 'Massagem japonesa de pressão', 60, 100, 180, 5 from segmentos where slug='massoterapia'
union all select id, 'Pacote Spa Day', 'Combinação de terapias em um dia', 180, 300, 600, 6 from segmentos where slug='massoterapia';

-- Micropigmentação
insert into atividades_catalogo (segmento_id, nome, descricao_curta, duracao_padrao_min, preco_sugerido_min, preco_sugerido_max, ordem)
select id, 'Micropigmentação de Sobrancelhas (Fio a Fio)', 'Técnica realista de sobrancelha', 120, 400, 800, 1 from segmentos where slug='micropigmentacao'
union all select id, 'Micropigmentação Labial', 'Pigmentação de contorno e cor labial', 120, 400, 900, 2 from segmentos where slug='micropigmentacao'
union all select id, 'Design de Sobrancelhas com Henna', 'Coloração temporária e design', 40, 40, 80, 3 from segmentos where slug='micropigmentacao'
union all select id, 'Retoque de Micropigmentação', 'Manutenção de procedimento anterior', 60, 150, 300, 4 from segmentos where slug='micropigmentacao'
union all select id, 'Micropigmentação Capilar', 'Efeito raspado no couro cabeludo', 180, 500, 1200, 5 from segmentos where slug='micropigmentacao';

-- Maquiagem
insert into atividades_catalogo (segmento_id, nome, descricao_curta, duracao_padrao_min, preco_sugerido_min, preco_sugerido_max, ordem)
select id, 'Maquiagem Social', 'Para eventos e festas', 60, 100, 200, 1 from segmentos where slug='maquiagem'
union all select id, 'Maquiagem para Noivas', 'Inclui teste prévio', 120, 300, 800, 2 from segmentos where slug='maquiagem'
union all select id, 'Maquiagem para Formatura', 'Produção completa', 90, 150, 300, 3 from segmentos where slug='maquiagem'
union all select id, 'Aula de Automaquiagem', 'Ensino individual ou em grupo', 90, 150, 350, 4 from segmentos where slug='maquiagem'
union all select id, 'Aplicação de Cílios Postiços', 'Cílios para efeito imediato', 30, 40, 80, 5 from segmentos where slug='maquiagem';

-- Podologia
insert into atividades_catalogo (segmento_id, nome, descricao_curta, duracao_padrao_min, preco_sugerido_min, preco_sugerido_max, ordem)
select id, 'Avaliação Podológica', 'Diagnóstico inicial dos pés', 40, 60, 120, 1 from segmentos where slug='podologia'
union all select id, 'Tratamento de Unha Encravada', 'Correção e alívio de dor', 45, 80, 150, 2 from segmentos where slug='podologia'
union all select id, 'Remoção de Calos e Calosidades', 'Lixamento terapêutico', 40, 60, 110, 3 from segmentos where slug='podologia'
union all select id, 'Órtese de Silicone', 'Correção de deformidades leves', 50, 90, 180, 4 from segmentos where slug='podologia';

-- ============================================================
-- ATIVIDADES — segmentos novos
-- ============================================================

-- Tatuagem e Piercing
insert into atividades_catalogo (segmento_id, nome, descricao_curta, duracao_padrao_min, preco_sugerido_min, preco_sugerido_max, ordem)
select id, 'Tatuagem Pequena', 'Até 5cm, traço simples', 60, 100, 250, 1 from segmentos where slug='tatuagem_piercing'
union all select id, 'Tatuagem Média/Grande (sessão)', 'Cobrada por sessão, orçamento prévio', 180, 300, 900, 2 from segmentos where slug='tatuagem_piercing'
union all select id, 'Piercing Simples', 'Orelha, nariz ou umbigo', 20, 40, 90, 3 from segmentos where slug='tatuagem_piercing'
union all select id, 'Piercing em Cartilagem', 'Procedimento com material próprio', 30, 60, 130, 4 from segmentos where slug='tatuagem_piercing'
union all select id, 'Avaliação para Cover-up', 'Consulta para cobertura de tatuagem antiga', 30, 0, 0, 5 from segmentos where slug='tatuagem_piercing';

-- Bronzeamento Artificial
insert into atividades_catalogo (segmento_id, nome, descricao_curta, duracao_padrao_min, preco_sugerido_min, preco_sugerido_max, ordem)
select id, 'Bronzeamento em Cabine', 'Sessão de bronzeamento UV', 20, 40, 80, 1 from segmentos where slug='bronzeamento'
union all select id, 'Bronzeamento a Jato (Spray Tan)', 'Aplicação de bronzeador sem sol', 30, 90, 180, 2 from segmentos where slug='bronzeamento'
union all select id, 'Manutenção de Bronzeado', 'Retoque entre sessões', 15, 40, 70, 3 from segmentos where slug='bronzeamento';

-- Extensão de Cílios e Sobrancelhas
insert into atividades_catalogo (segmento_id, nome, descricao_curta, duracao_padrao_min, preco_sugerido_min, preco_sugerido_max, ordem)
select id, 'Extensão de Cílios Fio a Fio', 'Aplicação clássica', 90, 120, 220, 1 from segmentos where slug='cilios_extensao'
union all select id, 'Extensão de Cílios Volume Russo', 'Técnica de volume', 120, 180, 320, 2 from segmentos where slug='cilios_extensao'
union all select id, 'Lash Lifting', 'Curvatura natural dos cílios', 60, 100, 180, 3 from segmentos where slug='cilios_extensao'
union all select id, 'Brow Lamination', 'Alinhamento e fixação de sobrancelha', 45, 90, 160, 4 from segmentos where slug='cilios_extensao'
union all select id, 'Manutenção de Extensão', 'Retoque a cada 2-3 semanas', 60, 80, 150, 5 from segmentos where slug='cilios_extensao';

-- Nutricionista [SAÚDE REGULADA — agendamento simples, sem prontuário clínico]
insert into atividades_catalogo (segmento_id, nome, descricao_curta, duracao_padrao_min, preco_sugerido_min, preco_sugerido_max, ordem)
select id, 'Consulta Nutricional Inicial', 'Primeira avaliação e anamnese', 60, 150, 350, 1 from segmentos where slug='nutricionista'
union all select id, 'Retorno Nutricional', 'Acompanhamento de plano em andamento', 30, 80, 200, 2 from segmentos where slug='nutricionista'
union all select id, 'Avaliação de Bioimpedância', 'Medição de composição corporal', 20, 60, 120, 3 from segmentos where slug='nutricionista'
union all select id, 'Consulta de Nutrição Esportiva', 'Foco em performance e treino', 60, 150, 350, 4 from segmentos where slug='nutricionista';

-- Psicologia / Terapia [SAÚDE REGULADA — dado extra sensível, ver nota]
insert into atividades_catalogo (segmento_id, nome, descricao_curta, duracao_padrao_min, preco_sugerido_min, preco_sugerido_max, ordem)
select id, 'Sessão de Psicoterapia Individual', 'Atendimento presencial ou online', 50, 120, 300, 1 from segmentos where slug='psicologia'
union all select id, 'Sessão de Terapia de Casal', 'Atendimento para casais', 60, 180, 400, 2 from segmentos where slug='psicologia'
union all select id, 'Avaliação Psicológica Inicial', 'Primeira sessão e anamnese', 60, 150, 350, 3 from segmentos where slug='psicologia'
union all select id, 'Sessão Online', 'Atendimento por videochamada', 50, 100, 280, 4 from segmentos where slug='psicologia';

-- Personal Trainer / Estúdio
insert into atividades_catalogo (segmento_id, nome, descricao_curta, duracao_padrao_min, preco_sugerido_min, preco_sugerido_max, ordem)
select id, 'Treino Personal (avulso)', 'Sessão individual', 60, 80, 180, 1 from segmentos where slug='personal_trainer'
union all select id, 'Avaliação Física', 'Anamnese e teste de condicionamento', 45, 60, 150, 2 from segmentos where slug='personal_trainer'
union all select id, 'Aula de Pilates', 'Individual ou em grupo pequeno', 50, 60, 130, 3 from segmentos where slug='personal_trainer'
union all select id, 'Treino em Dupla', 'Sessão compartilhada', 60, 100, 200, 4 from segmentos where slug='personal_trainer';

-- Terapias Holísticas
insert into atividades_catalogo (segmento_id, nome, descricao_curta, duracao_padrao_min, preco_sugerido_min, preco_sugerido_max, ordem)
select id, 'Sessão de Reiki', 'Terapia energética', 50, 80, 160, 1 from segmentos where slug='terapias_holisticas'
union all select id, 'Acupuntura', 'Sessão terapêutica com agulhas', 45, 100, 220, 2 from segmentos where slug='terapias_holisticas'
union all select id, 'Auriculoterapia', 'Estímulo de pontos na orelha', 30, 60, 120, 3 from segmentos where slug='terapias_holisticas'
union all select id, 'Terapia com Cristais', 'Sessão de equilíbrio energético', 50, 70, 150, 4 from segmentos where slug='terapias_holisticas';

-- Odontologia [SAÚDE REGULADA — apenas agendamento; sem odontograma/prontuário]
insert into atividades_catalogo (segmento_id, nome, descricao_curta, duracao_padrao_min, preco_sugerido_min, preco_sugerido_max, ordem)
select id, 'Consulta / Avaliação Odontológica', 'Primeira consulta e diagnóstico', 40, 100, 250, 1 from segmentos where slug='odontologia'
union all select id, 'Limpeza (Profilaxia)', 'Remoção de tártaro e placa', 40, 100, 200, 2 from segmentos where slug='odontologia'
union all select id, 'Clareamento Dental', 'Sessão de clareamento em consultório', 60, 300, 800, 3 from segmentos where slug='odontologia'
union all select id, 'Restauração', 'Tratamento de cárie, valor varia por dente', 45, 120, 350, 4 from segmentos where slug='odontologia'
union all select id, 'Avaliação Ortodôntica', 'Consulta para aparelho', 40, 100, 250, 5 from segmentos where slug='odontologia';

-- Fisioterapia [SAÚDE REGULADA — apenas agendamento; sem prontuário/evolução clínica]
insert into atividades_catalogo (segmento_id, nome, descricao_curta, duracao_padrao_min, preco_sugerido_min, preco_sugerido_max, ordem)
select id, 'Avaliação Fisioterapêutica', 'Anamnese e diagnóstico funcional', 50, 100, 220, 1 from segmentos where slug='fisioterapia'
union all select id, 'Sessão de Fisioterapia Ortopédica', 'Tratamento de lesões e dores', 50, 90, 180, 2 from segmentos where slug='fisioterapia'
union all select id, 'Sessão de RPG', 'Reeducação postural global', 50, 100, 200, 3 from segmentos where slug='fisioterapia'
union all select id, 'Pilates Clínico', 'Sessão terapêutica individual', 50, 90, 180, 4 from segmentos where slug='fisioterapia'
union all select id, 'Drenagem Linfática Terapêutica', 'Indicação pós-cirúrgica ou clínica', 50, 90, 170, 5 from segmentos where slug='fisioterapia';
