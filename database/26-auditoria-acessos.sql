-- SalonOS — Migração 26: log de auditoria de acesso a dado sensível (LGPD)
-- Rodar depois de 25.
--
-- Só leitura via admin (David, painel-admin) -- não é o dono do salão que
-- vê isso, é quem opera a plataforma. Escrita vem só do helper
-- src/lib/auditoria.js (via req.supabase autenticado ou service_role no
-- webhook do WhatsApp), nunca direto do front -- por isso não tem policy
-- de insert restritiva por linha: quem grava já passou pela autenticação
-- normal da rota que disparou o registro.

create table auditoria_acessos (
  id uuid primary key default gen_random_uuid(),
  estabelecimento_id uuid references estabelecimentos(id) not null,
  ator text not null,
  operacao text not null check (operacao in ('read', 'write', 'export')),
  tabela text not null,
  registro_id uuid,
  detalhe text,
  created_at timestamptz default now()
);
create index idx_auditoria_estabelecimento on auditoria_acessos (estabelecimento_id, created_at desc);

alter table auditoria_acessos enable row level security;

-- Leitura só por quem está em `admins` (mesma função usada no resto do
-- painel-admin) -- dono de salão não vê o próprio log de auditoria nesta
-- fase (decisão consciente, ver CLAUDE.md).
create policy "auditoria_select_admin" on auditoria_acessos for select
  using ( sou_admin() );

-- Insert liberado pra qualquer sessão autenticada (RLS não filtra por
-- estabelecimento_id aqui de propósito -- quem grava é sempre código do
-- próprio backend, nunca uma escrita livre vinda do cliente).
create policy "auditoria_insert_autenticado" on auditoria_acessos for insert
  to authenticated, service_role
  with check ( true );
