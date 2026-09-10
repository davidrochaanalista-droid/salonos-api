-- ============================================================
-- SalonOS — Script único para rodar no Supabase (SQL Editor)
-- Contém, na ordem correta: schema base + migração de onboarding/
-- histórico + catálogo completo de 18 segmentos.
-- Cole este arquivo inteiro no SQL Editor do Supabase e execute
-- de uma vez (botão "Run"). Se preferir rodar em partes, os
-- arquivos numerados 01/03/04 continuam disponíveis separadamente
-- — a ordem entre eles é a mesma que aparece aqui.
-- ============================================================


-- ============================================================
-- PARTE 1 de 3 — Schema base (proprietário, estabelecimento,
-- segmento, catálogo, cliente, memória de WhatsApp, RLS)
-- ============================================================

-- ============================================================
-- SalonOS — Schema Fase 1 (Supabase / Postgres)
-- Cadastro de proprietário, estabelecimento, segmento, atividades
-- + memória de conversa do WhatsApp com IA
-- Adaptado do padrão RLS validado em produção no GiroCerto
-- ============================================================

-- ── EXTENSÕES ──
create extension if not exists "pgcrypto";

-- ============================================================
-- 1. PROPRIETÁRIOS (dono do estabelecimento, vinculado ao auth.users)
-- ============================================================
create table proprietarios (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) not null unique,
  nome text not null,
  telefone text not null,
  cpf text,
  created_at timestamptz default now()
);

-- ============================================================
-- 2. SEGMENTOS — taxonomia curada, não gerada por IA a cada vez
-- Por que não é a IA que gera essa lista: uma lista fixa e revisada
-- é mais confiável, sem custo de API, e não varia a cada cadastro.
-- A IA entra depois, para SUGERIR atividades dentro do segmento
-- escolhido (ver seção 4) e para responder o cliente no WhatsApp.
-- ============================================================
create table segmentos (
  id uuid primary key default gen_random_uuid(),
  nome text not null unique,
  slug text not null unique,
  icone text,
  ordem int default 0
);

insert into segmentos (nome, slug, icone, ordem) values
  ('Cabeleireiro / Salão de Beleza', 'cabeleireiro', '💇', 1),
  ('Barbearia', 'barbearia', '💈', 2),
  ('Manicure e Pedicure', 'manicure', '💅', 3),
  ('Esteticista / Clínica de Estética', 'esteticista', '✨', 4),
  ('Depilação', 'depilacao', '🧴', 5),
  ('Massoterapia / Spa', 'massoterapia', '🧖', 6),
  ('Micropigmentação / Design de Sobrancelhas', 'micropigmentacao', '🪄', 7),
  ('Maquiagem', 'maquiagem', '💄', 8),
  ('Podologia', 'podologia', '🦶', 9),
  ('Outro', 'outro', '📋', 99);

-- ============================================================
-- 3. ESTABELECIMENTOS
-- ============================================================
create table estabelecimentos (
  id uuid primary key default gen_random_uuid(),
  proprietario_id uuid references proprietarios(id) not null,
  segmento_id uuid references segmentos(id) not null,
  nome text not null,
  whatsapp text not null,
  cnpj text,
  cidade text,
  bairro text,
  endereco text,
  cep text,
  latitude numeric,
  longitude numeric,
  horario_abertura time default '09:00',
  horario_fechamento time default '19:00',
  dias_funcionamento text[] default array['seg','ter','qua','qui','sex'],
  plano text default 'base' check (plano in ('base','crescimento','escala')),
  created_at timestamptz default now()
);

-- ============================================================
-- 4. ATIVIDADES — catálogo por segmento (curado, não gerado por IA)
-- Quando o proprietário escolhe o segmento "Cabeleireiro", a tela
-- de cadastro consulta esta tabela filtrando por segmento_id e
-- apresenta as opções pré-marcadas para ele confirmar ou remover.
-- Isso é o que o pedido descreve como "a IA oferece opções" — na
-- prática funciona melhor como catálogo curado + IA só para os
-- casos de atividade customizada que não está na lista (seção 4b).
-- ============================================================
create table atividades_catalogo (
  id uuid primary key default gen_random_uuid(),
  segmento_id uuid references segmentos(id) not null,
  nome text not null,
  descricao_curta text,
  duracao_padrao_min int,
  preco_sugerido_min numeric,
  preco_sugerido_max numeric,
  ordem int default 0
);

-- Exemplo de seed para o segmento "Cabeleireiro"
insert into atividades_catalogo (segmento_id, nome, descricao_curta, duracao_padrao_min, preco_sugerido_min, preco_sugerido_max, ordem)
select id, 'Corte Feminino', 'Corte com lavagem e finalização', 60, 60, 120, 1 from segmentos where slug='cabeleireiro'
union all select id, 'Corte Masculino', 'Corte tradicional', 40, 35, 70, 2 from segmentos where slug='cabeleireiro'
union all select id, 'Coloração Completa', 'Tintura raiz + comprimento', 120, 120, 280, 3 from segmentos where slug='cabeleireiro'
union all select id, 'Mechas / Luzes', 'Técnica de mechas com touca ou papel', 150, 150, 350, 4 from segmentos where slug='cabeleireiro'
union all select id, 'Progressiva', 'Alisamento e redução de volume', 180, 180, 400, 5 from segmentos where slug='cabeleireiro'
union all select id, 'Hidratação Profunda', 'Tratamento capilar reconstrutor', 60, 60, 120, 6 from segmentos where slug='cabeleireiro'
union all select id, 'Escova Modeladora', 'Escova com finalização', 50, 50, 90, 7 from segmentos where slug='cabeleireiro'
union all select id, 'Penteado para Eventos', 'Penteado para festas e cerimônias', 90, 100, 250, 8 from segmentos where slug='cabeleireiro';

-- Vínculo real: o que ESTE estabelecimento oferece (a partir do catálogo, ou customizado)
create table estabelecimento_atividades (
  id uuid primary key default gen_random_uuid(),
  estabelecimento_id uuid references estabelecimentos(id) not null,
  atividade_catalogo_id uuid references atividades_catalogo(id), -- null se for customizada
  nome text not null, -- copiado do catálogo ou digitado pelo proprietário
  descricao text,
  duracao_min int,
  preco numeric,
  ativo boolean default true,
  created_at timestamptz default now()
);

-- ============================================================
-- 5. CLIENTES (do estabelecimento, distinto de proprietários)
-- ============================================================
create table clientes (
  id uuid primary key default gen_random_uuid(),
  estabelecimento_id uuid references estabelecimentos(id) not null,
  nome text,
  telefone text not null,
  observacoes_criptografadas text, -- ver blueprint-backend-salonos.md seção 4 (AES-256 em camada de aplicação)
  created_at timestamptz default now(),
  unique(estabelecimento_id, telefone)
);

-- ============================================================
-- 6. MEMÓRIA DE CONVERSA DO WHATSAPP — o núcleo do pedido de hoje
-- Duas tabelas: histórico bruto (para auditoria/LGPD) e resumo
-- vivo por cliente (para não reenviar o histórico inteiro a cada
-- chamada de IA — caro e lento). O resumo é atualizado a cada N
-- mensagens, não a cada mensagem.
-- ============================================================
create table whatsapp_mensagens (
  id uuid primary key default gen_random_uuid(),
  estabelecimento_id uuid references estabelecimentos(id) not null,
  cliente_id uuid references clientes(id) not null,
  direcao text not null check (direcao in ('recebida','enviada')),
  conteudo text not null,
  modelo_ia text, -- ex: 'llama-3.3-70b-versatile', null se mensagem humana
  created_at timestamptz default now()
);

create table whatsapp_memoria_cliente (
  id uuid primary key default gen_random_uuid(),
  estabelecimento_id uuid references estabelecimentos(id) not null,
  cliente_id uuid references clientes(id) not null unique,
  resumo text not null default '', -- ex: "Cliente prefere tons frios, alérgica a amônia, geralmente agenda às sextas à tarde"
  ultima_atualizacao timestamptz default now(),
  total_interacoes int default 0
);

-- ============================================================
-- 7. RLS EM CASCATA — mesmo padrão do blueprint-backend-salonos.md
-- ============================================================
create or replace function usuario_e_proprietario(p_estabelecimento_id uuid)
returns boolean
language sql security definer
as $$
  select exists (
    select 1 from estabelecimentos e
    join proprietarios p on p.id = e.proprietario_id
    where e.id = p_estabelecimento_id and p.user_id = auth.uid()
  );
$$;

alter table estabelecimentos enable row level security;
create policy "proprietario ve seus proprios estabelecimentos"
on estabelecimentos for all
using ( exists (select 1 from proprietarios p where p.id = proprietario_id and p.user_id = auth.uid()) );

alter table estabelecimento_atividades enable row level security;
create policy "acesso a atividades do proprio estabelecimento"
on estabelecimento_atividades for all
using ( usuario_e_proprietario(estabelecimento_id) );

alter table clientes enable row level security;
create policy "acesso a clientes do proprio estabelecimento"
on clientes for all
using ( usuario_e_proprietario(estabelecimento_id) );

alter table whatsapp_mensagens enable row level security;
create policy "acesso a mensagens do proprio estabelecimento"
on whatsapp_mensagens for all
using ( usuario_e_proprietario(estabelecimento_id) );

alter table whatsapp_memoria_cliente enable row level security;
create policy "acesso a memoria do proprio estabelecimento"
on whatsapp_memoria_cliente for all
using ( usuario_e_proprietario(estabelecimento_id) );

-- Segmentos e catálogo são públicos para leitura (não têm dado sensível)
alter table segmentos enable row level security;
create policy "segmentos sao publicos para leitura" on segmentos for select using (true);

alter table atividades_catalogo enable row level security;
create policy "catalogo e publico para leitura" on atividades_catalogo for select using (true);

-- ============================================================
-- 8. TRIGGER: signup do proprietário (padrão SECURITY DEFINER do GiroCerto)
-- ============================================================
create or replace function criar_proprietario_no_signup()
returns trigger
language plpgsql security definer
as $$
begin
  insert into proprietarios (user_id, nome, telefone)
  values (new.id, coalesce(new.raw_user_meta_data->>'nome', ''), coalesce(new.raw_user_meta_data->>'telefone', ''));
  return new;
end;
$$;

create trigger trg_criar_proprietario
after insert on auth.users
for each row execute function criar_proprietario_no_signup();


-- ============================================================
-- PARTE 2 de 3 — Onboarding (endereço, aniversário, estado de
-- coleta) + profissionais + histórico de atendimentos
-- ============================================================

-- ============================================================
-- SalonOS — Migração 03: Onboarding de cliente novo + histórico
-- de atendimento (para o fluxo "mesmo procedimento/profissional?")
-- Rodar depois do 01-schema-fase1.sql
-- ============================================================

-- ── 1. Campos novos em clientes ──
alter table clientes add column if not exists endereco text;
alter table clientes add column if not exists data_nascimento date; -- opcional, ver README-fase1.md
alter table clientes add column if not exists estado_onboarding text not null default 'novo'
  check (estado_onboarding in ('novo','aguardando_nome','aguardando_endereco','aguardando_aniversario','completo'));
alter table clientes add column if not exists ultima_interacao_em timestamptz default now();

-- ── 2. Profissionais do estabelecimento ──
create table if not exists profissionais (
  id uuid primary key default gen_random_uuid(),
  estabelecimento_id uuid references estabelecimentos(id) not null,
  nome text not null,
  ativo boolean default true,
  created_at timestamptz default now()
);

-- ── 3. Histórico de atendimento — é isso que permite a IA saber
-- "da última vez você fez X com a profissional Y"
-- ============================================================
create table if not exists atendimentos (
  id uuid primary key default gen_random_uuid(),
  estabelecimento_id uuid references estabelecimentos(id) not null,
  cliente_id uuid references clientes(id) not null,
  estabelecimento_atividade_id uuid references estabelecimento_atividades(id),
  profissional_id uuid references profissionais(id),
  data_atendimento timestamptz not null default now(),
  origem text default 'whatsapp' check (origem in ('whatsapp','painel','manual')),
  created_at timestamptz default now()
);
create index if not exists idx_atendimentos_cliente_data on atendimentos (cliente_id, data_atendimento desc);

-- ── 4. RLS para as tabelas novas (mesmo padrão em cascata) ──
alter table profissionais enable row level security;
create policy "acesso a profissionais do proprio estabelecimento"
on profissionais for all
using ( usuario_e_proprietario(estabelecimento_id) );

alter table atendimentos enable row level security;
create policy "acesso a atendimentos do proprio estabelecimento"
on atendimentos for all
using ( usuario_e_proprietario(estabelecimento_id) );


-- ============================================================
-- PARTE 3 de 3 — Catálogo completo (18 segmentos, 83 atividades)
-- ============================================================

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
