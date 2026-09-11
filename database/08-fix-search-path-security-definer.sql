-- ============================================================
-- SalonOS — Migração 08: corrige search_path das funções SECURITY DEFINER
--
-- Bug real, achado testando o cadastro de verdade pela primeira vez
-- (11/09/2026): signup retornava "Database error saving new user".
-- Causa: `criar_proprietario_no_signup()` é disparada como trigger em
-- auth.users, contexto onde o search_path não inclui `public` por
-- padrão -- a tabela `proprietarios` (sem schema explícito) não era
-- encontrada. `CREATE OR REPLACE FUNCTION` é seguro rodar de novo,
-- não recria nada, só troca a definição.
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
