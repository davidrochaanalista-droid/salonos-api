-- ============================================================
-- SalonOS — Migração 34: gênero do proprietário (tema claro/escuro)
-- Rodar depois de 33.
--
-- Pedido do David: o cadastro do proprietário ganha um campo "gênero".
-- Se masculino, o layout do painel do proprietário e das telas do
-- estabelecimento (cadastro-real.html, painel-proprietario.html,
-- salon-v6.html) muda para um tom mais escuro; se feminino, continua
-- no tom nude/rosé que já existe hoje. Nulo (proprietário cadastrado
-- antes desta migração) se comporta como feminino -- ninguém que já
-- usa o sistema tem o visual trocado sozinho.
-- ============================================================

alter table proprietarios add column if not exists genero text
  check (genero is null or genero in ('masculino', 'feminino'));

-- criar_proprietario_no_signup (ver 08-fix-search-path-security-definer.sql)
-- já lê nome/telefone de raw_user_meta_data no signup via convite
-- (cadastro-real.html, sb.auth.signUp). Estende pra também gravar
-- genero quando vier no mesmo metadata -- create or replace é seguro,
-- só troca a definição, não recria o trigger.
create or replace function criar_proprietario_no_signup()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.proprietarios (user_id, nome, telefone, genero)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'nome', ''),
    coalesce(new.raw_user_meta_data->>'telefone', ''),
    nullif(new.raw_user_meta_data->>'genero', '')
  );
  return new;
end;
$$;
