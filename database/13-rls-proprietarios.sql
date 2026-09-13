-- ============================================================
-- SalonOS — Migração 13: policy de leitura em proprietarios
-- Causa raiz (achada testando cadastro-real.html de ponta a ponta):
-- a tabela `proprietarios` tem RLS habilitado (relrowsecurity=true),
-- mas nenhuma migração jamais criou uma policy para ela -- RLS
-- habilitado sem nenhuma policy bloqueia TODO acesso via API (só o
-- SQL Editor, rodando como superusuário, escapa disso), mesmo o
-- próprio proprietário tentando ler seu próprio registro. Isso
-- quebrava POST /estabelecimentos (busca proprietario_id) e
-- GET /proprietarios/me.
-- ============================================================

create policy "proprietario ve o proprio cadastro"
on proprietarios for select
using ( user_id = auth.uid() );
