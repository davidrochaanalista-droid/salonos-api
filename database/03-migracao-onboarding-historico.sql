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
