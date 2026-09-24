-- ============================================================
-- SalonOS — Migração 35: login separado por salão
-- Rodar depois de 34.
--
-- Falha de segurança real: hoje só existe o login do proprietário, usado
-- tanto pro painel-proprietario.html (margem consolidada de rede) quanto
-- pro salon-v6.html (operação do dia a dia). Se o dono compartilha essa
-- senha com um funcionário pra ele mexer na agenda, esse funcionário
-- também abre o painel de rede e vê dado financeiro que não é dele.
--
-- Cadastro novo passa a criar dois logins: o do proprietário (tela 1,
-- já existia) e um por salão (tela 2, novo -- POST /estabelecimentos
-- ganhou email_salao/senha_salao). Contas já existentes (Harry Studio,
-- Studio Teste QA) ficam de fora por decisão explícita -- só cadastro
-- novo por enquanto.
-- ============================================================

alter table estabelecimentos add column if not exists login_user_id uuid references auth.users(id);
create unique index if not exists estabelecimentos_login_user_id_key on estabelecimentos(login_user_id);

-- usuario_e_proprietario é chamada por ~11 migrações diferentes pra RLS
-- (agenda, comandas, caixa, clientes, produtos, etc.) -- estender aqui
-- cobre todas de uma vez, create or replace não quebra nenhuma policy
-- que já a referencia pelo nome.
create or replace function usuario_e_proprietario(p_estabelecimento_id uuid)
returns boolean
language sql security definer
set search_path = public
as $$
  select exists (
    select 1 from public.estabelecimentos e
    left join public.proprietarios p on p.id = e.proprietario_id
    where e.id = p_estabelecimento_id
      and (p.user_id = auth.uid() or e.login_user_id = auth.uid())
  );
$$;

-- estabelecimentos tem sua própria policy (não passa pela função acima) --
-- substitui a policy única por duas: dono continua com acesso total, login
-- de salão só lê/atualiza o próprio registro (nunca apaga nem cria outro).
-- PATCH /estabelecimentos/:id já tem whitelist de campos que não inclui
-- login_user_id/proprietario_id, então não há caminho de escalonamento.
drop policy if exists "proprietario ve seus proprios estabelecimentos" on estabelecimentos;

create policy "proprietario tem acesso total aos proprios estabelecimentos"
on estabelecimentos for all
using ( exists (select 1 from proprietarios p where p.id = proprietario_id and p.user_id = auth.uid()) );

create policy "login do salao ve e atualiza o proprio estabelecimento"
on estabelecimentos for select
using ( login_user_id = auth.uid() );

create policy "login do salao atualiza o proprio estabelecimento"
on estabelecimentos for update
using ( login_user_id = auth.uid() )
with check ( login_user_id = auth.uid() );
