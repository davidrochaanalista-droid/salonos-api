-- ============================================================
-- SalonOS — Migração 23: admins (painel-admin.html real)
-- Rodar depois de 07 (usa planos_precos/status_assinatura).
--
-- Tabela separada de `proprietarios` de propósito: admin da SalonOS
-- não é dono de salão, é operador interno da plataforma. RLS fica
-- habilitada mas SEM policy `for all` -- só leitura pelo próprio via
-- sou_admin(). As rotas admin (src/routes/admin.js) não usam RLS pra
-- ler dado de outras contas -- usam a service_role key de propósito,
-- porque admin legitimamente precisa de leitura cross-tenant, o que o
-- padrão de RLS-por-usuário (req.supabase escopado ao dono) não
-- permite por design. sou_admin() é usado só pra autorizar a troca
-- de client (ver src/middleware/exigirAdmin.js), não pra filtrar linha.
--
-- Seed do primeiro admin: rodar manualmente depois desta migração,
-- ex.: insert into admins (user_id, nome) values ('<auth.users.id de
-- davidrocha.coitinho@gmail.com>', 'David');
-- ============================================================

create table admins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) unique not null,
  nome text,
  created_at timestamptz default now()
);

alter table admins enable row level security;

create or replace function sou_admin()
returns boolean
language sql security definer
stable
as $$
  select exists(select 1 from admins where user_id = auth.uid());
$$;
