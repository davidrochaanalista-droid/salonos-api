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
set search_path = public
as $$
  select exists (
    select 1 from public.estabelecimentos e
    join public.proprietarios p on p.id = e.proprietario_id
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
set search_path = public
as $$
begin
  insert into public.proprietarios (user_id, nome, telefone)
  values (new.id, coalesce(new.raw_user_meta_data->>'nome', ''), coalesce(new.raw_user_meta_data->>'telefone', ''));
  return new;
end;
$$;

create trigger trg_criar_proprietario
after insert on auth.users
for each row execute function criar_proprietario_no_signup();
