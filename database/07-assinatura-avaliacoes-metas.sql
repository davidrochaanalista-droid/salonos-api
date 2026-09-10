-- ============================================================
-- SalonOS — Migração 07: Assinatura (MRR), avaliações, metas
-- Rodar depois de 01, 03, 04, 05, 06.
--
-- IMPORTANTE: isso cria o MODELO DE DADO pra calcular MRR de verdade
-- (preço configurado por plano × status da assinatura), NÃO integra
-- cobrança automática (Stripe/Mercado Pago/etc.) — isso é uma decisão
-- de gateway de pagamento separada, que ninguém tomou ainda. Por
-- enquanto o status da assinatura é gerenciado manualmente (painel
-- admin ou update direto), não por webhook de pagamento.
-- ============================================================

-- ── 1. Preço por plano — configurável sem precisar de deploy ──
create table if not exists planos_precos (
  plano text primary key check (plano in ('base','crescimento','escala')),
  valor_mensal numeric not null
);
insert into planos_precos (plano, valor_mensal) values
  ('base', 97), ('crescimento', 197), ('escala', 347)
on conflict (plano) do nothing;

-- ── 2. Status de assinatura do estabelecimento ──
alter table estabelecimentos add column if not exists status_assinatura text not null default 'trial'
  check (status_assinatura in ('trial', 'ativo', 'inadimplente', 'cancelado'));

-- ── 3. Avaliações — 1 por atendimento, cliente avalia depois do serviço ──
create table if not exists avaliacoes (
  id uuid primary key default gen_random_uuid(),
  estabelecimento_id uuid references estabelecimentos(id) not null,
  atendimento_id uuid references atendimentos(id) not null unique,
  cliente_id uuid references clientes(id) not null,
  nota int not null check (nota between 1 and 5),
  comentario text,
  created_at timestamptz default now()
);
create index if not exists idx_avaliacoes_estabelecimento on avaliacoes (estabelecimento_id);

-- ── 4. Metas mensais de receita, por estabelecimento ──
create table if not exists metas_mensais (
  id uuid primary key default gen_random_uuid(),
  estabelecimento_id uuid references estabelecimentos(id) not null,
  ano_mes date not null, -- sempre dia 1 do mês, ex: '2026-09-01'
  valor_meta numeric not null,
  created_at timestamptz default now(),
  unique(estabelecimento_id, ano_mes)
);

-- ── 5. RLS em cascata — mesmo padrão do resto do schema ──
alter table avaliacoes enable row level security;
create policy "acesso a avaliacoes do proprio estabelecimento"
on avaliacoes for all
using ( usuario_e_proprietario(estabelecimento_id) );

alter table metas_mensais enable row level security;
create policy "acesso a metas do proprio estabelecimento"
on metas_mensais for all
using ( usuario_e_proprietario(estabelecimento_id) );

-- Preços de plano são públicos pra leitura (não têm dado sensível,
-- e o front precisa mostrar preço na tela de upgrade de plano)
alter table planos_precos enable row level security;
create policy "precos de plano sao publicos para leitura" on planos_precos for select using (true);

-- ── 6. Avaliação é enviada por link público (cliente não tem login) —
-- POST feito sem token de usuário, então a policy de escrita usa
-- security definer via função em vez de RLS baseada em auth.uid().
-- ============================================================
create or replace function registrar_avaliacao(p_atendimento_id uuid, p_nota int, p_comentario text)
returns avaliacoes
language plpgsql security definer
as $$
declare
  v_atendimento record;
  v_avaliacao avaliacoes;
begin
  select estabelecimento_id, cliente_id into v_atendimento from atendimentos where id = p_atendimento_id;
  if not found then
    raise exception 'Atendimento não encontrado';
  end if;

  insert into avaliacoes (estabelecimento_id, atendimento_id, cliente_id, nota, comentario)
  values (v_atendimento.estabelecimento_id, p_atendimento_id, v_atendimento.cliente_id, p_nota, p_comentario)
  on conflict (atendimento_id) do update set nota = excluded.nota, comentario = excluded.comentario
  returning * into v_avaliacao;

  return v_avaliacao;
end;
$$;
