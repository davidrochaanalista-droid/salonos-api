-- ============================================================
-- SalonOS — Migração 36: login do salão não vira proprietário
-- Rodar depois de 35.
--
-- Bug real achado testando localmente (antes de subir pra produção,
-- ainda bem): criar_proprietario_no_signup() dispara pra QUALQUER usuário
-- novo em auth.users, não só pra convite de proprietário -- inclusive o
-- login do salão criado em POST /estabelecimentos (database/35-login-
-- salao.sql). Isso criava uma linha em proprietarios (nome='', telefone='')
-- pro login do salão também, o que quebrava por completo o bloqueio do
-- painel-proprietario.html: a checagem "esse login tem linha em
-- proprietarios?" passava pra QUALQUER login de salão, deixando o
-- funcionário abrir o painel de rede mesmo assim -- exatamente o buraco
-- de segurança que essa mudança inteira existe pra fechar.
--
-- Corrigido marcando o login do salão com user_metadata
-- {tipo:'login_salao'} na hora da criação (estabelecimentos.js) e fazendo
-- o trigger pular esse caso.
-- ============================================================

create or replace function criar_proprietario_no_signup()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.raw_user_meta_data->>'tipo' = 'login_salao' then
    return new;
  end if;

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
