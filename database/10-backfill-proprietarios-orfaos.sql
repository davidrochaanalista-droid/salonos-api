-- ============================================================
-- SalonOS — Migração 10: repara usuários órfãos (auth.users sem
-- proprietarios correspondente)
--
-- Causa raiz (achada testando o cadastro real em 11/09/2026): a
-- primeira tentativa de signup, antes da correção do search_path
-- (migração 08), criou o registro em auth.users mesmo com a trigger
-- falhando -- o Supabase/GoTrue não reverteu a criação do usuário só
-- porque a trigger deu erro. Retentar o cadastro com o mesmo e-mail
-- não recria o usuário (já existe, só reenvia confirmação), então a
-- trigger nunca dispara de novo e `proprietarios` fica sem a linha.
--
-- Este backfill é seguro rodar quantas vezes quiser (só insere o que
-- estiver faltando).
-- ============================================================

insert into public.proprietarios (user_id, nome, telefone)
select u.id, coalesce(u.raw_user_meta_data->>'nome', ''), coalesce(u.raw_user_meta_data->>'telefone', '')
from auth.users u
left join public.proprietarios p on p.user_id = u.id
where p.user_id is null;
