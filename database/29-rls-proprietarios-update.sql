-- SalonOS — Migração 29: policy de update em proprietarios
-- Rodar depois de 28.
--
-- proprietarios tem RLS habilitado, mas só existe policy de select
-- (migração 13) -- sem policy de update, ninguém consegue gravar
-- nome/telefone via API (0 linhas afetadas, silencioso). Necessário pro
-- fluxo de convite: a pessoa convidada só tem nome/telefone reais depois
-- de PATCH /proprietarios/me, já que o trigger criar_proprietario_no_signup
-- roda no momento do convite, sem essa metadata ainda.

create policy "proprietario atualiza o proprio cadastro"
on proprietarios for update
using ( user_id = auth.uid() );
