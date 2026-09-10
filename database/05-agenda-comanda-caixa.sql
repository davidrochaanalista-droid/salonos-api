-- ============================================================
-- SalonOS — Migração 05: Agenda, Comanda e Caixa (margem real)
-- Rodar depois de 01, 03 e 04.
--
-- Isso é o que sustenta a promessa central do produto (ver
-- docs/SalonOS-estrategia-diferenciacao-2026.md, Eixo 1 e Eixo 6):
-- a comanda sabe o preço cobrado, o custo do insumo e a comissão da
-- profissional no mesmo lugar, então a margem real por atendimento
-- (e por estabelecimento, e por rede) é calculada, não estimada.
-- ============================================================

-- ── 1. Campos de custo/comissão que faltavam nas tabelas existentes ──
alter table estabelecimento_atividades add column if not exists custo_insumo_padrao numeric default 0;
alter table profissionais add column if not exists comissao_padrao_percentual numeric default 0
  check (comissao_padrao_percentual >= 0 and comissao_padrao_percentual <= 100);

-- ============================================================
-- 2. AGENDAMENTOS — o que está marcado para o futuro
-- (distinto de `atendimentos`, que registra o que já aconteceu)
-- ============================================================
create table if not exists agendamentos (
  id uuid primary key default gen_random_uuid(),
  estabelecimento_id uuid references estabelecimentos(id) not null,
  cliente_id uuid references clientes(id) not null,
  profissional_id uuid references profissionais(id),
  estabelecimento_atividade_id uuid references estabelecimento_atividades(id) not null,
  inicio timestamptz not null,
  fim timestamptz not null,
  status text not null default 'agendado'
    check (status in ('agendado','confirmado','em_atendimento','concluido','cancelado','nao_compareceu')),
  origem text not null default 'painel' check (origem in ('whatsapp','painel','manual')),
  observacao text,
  created_at timestamptz default now()
);
create index if not exists idx_agendamentos_estabelecimento_inicio on agendamentos (estabelecimento_id, inicio);
create index if not exists idx_agendamentos_profissional_inicio on agendamentos (profissional_id, inicio);

-- ============================================================
-- 3. COMANDAS — fechamento financeiro de um atendimento
-- ============================================================
create table if not exists comandas (
  id uuid primary key default gen_random_uuid(),
  estabelecimento_id uuid references estabelecimentos(id) not null,
  cliente_id uuid references clientes(id) not null,
  profissional_id uuid references profissionais(id),
  agendamento_id uuid references agendamentos(id),
  status text not null default 'aberta' check (status in ('aberta','fechada','cancelada')),
  forma_pagamento text check (forma_pagamento in ('dinheiro','pix','credito','debito','outro')),
  desconto numeric default 0,
  valor_total numeric default 0,
  valor_custo_total numeric default 0,
  valor_comissao_total numeric default 0,
  margem numeric default 0, -- valor_total - desconto - valor_custo_total - valor_comissao_total
  aberta_em timestamptz default now(),
  fechada_em timestamptz
);
create index if not exists idx_comandas_estabelecimento_fechada on comandas (estabelecimento_id, fechada_em desc);

-- ── Itens da comanda (um serviço/atividade por linha) ──
create table if not exists comanda_itens (
  id uuid primary key default gen_random_uuid(),
  comanda_id uuid references comandas(id) not null,
  estabelecimento_atividade_id uuid references estabelecimento_atividades(id) not null,
  quantidade int not null default 1,
  preco_unitario numeric not null,
  custo_insumo_unitario numeric not null default 0,
  comissao_percentual numeric not null default 0,
  created_at timestamptz default now()
);
create index if not exists idx_comanda_itens_comanda on comanda_itens (comanda_id);

-- ============================================================
-- 4. CAIXA — entradas/saídas do dia, é o que alimenta o "ao vivo"
-- ============================================================
create table if not exists caixa_entradas (
  id uuid primary key default gen_random_uuid(),
  estabelecimento_id uuid references estabelecimentos(id) not null,
  comanda_id uuid references comandas(id), -- null se for lançamento avulso
  tipo text not null check (tipo in ('entrada','saida')),
  valor numeric not null,
  forma_pagamento text,
  descricao text,
  created_at timestamptz default now()
);
create index if not exists idx_caixa_estabelecimento_data on caixa_entradas (estabelecimento_id, created_at desc);

-- ============================================================
-- 5. FUNÇÃO: fechar comanda — calcula totais, grava caixa, cria
-- atendimento (histórico) e cliente pode ser perguntado "mesmo de
-- sempre?" da próxima vez, tudo a partir de dado real, não mockado.
-- ============================================================
create or replace function fechar_comanda(p_comanda_id uuid, p_forma_pagamento text)
returns comandas
language plpgsql security definer
as $$
declare
  v_comanda comandas;
  v_totais record;
  v_item record;
begin
  select
    coalesce(sum(preco_unitario * quantidade), 0) as total,
    coalesce(sum(custo_insumo_unitario * quantidade), 0) as custo,
    coalesce(sum(preco_unitario * quantidade * comissao_percentual / 100.0), 0) as comissao
  into v_totais
  from comanda_itens where comanda_id = p_comanda_id;

  update comandas set
    status = 'fechada',
    forma_pagamento = p_forma_pagamento,
    valor_total = v_totais.total,
    valor_custo_total = v_totais.custo,
    valor_comissao_total = v_totais.comissao,
    margem = v_totais.total - coalesce(desconto, 0) - v_totais.custo - v_totais.comissao,
    fechada_em = now()
  where id = p_comanda_id
  returning * into v_comanda;

  insert into caixa_entradas (estabelecimento_id, comanda_id, tipo, valor, forma_pagamento, descricao)
  values (v_comanda.estabelecimento_id, v_comanda.id, 'entrada', v_comanda.valor_total - coalesce(v_comanda.desconto, 0), p_forma_pagamento, 'Comanda fechada');

  for v_item in select * from comanda_itens where comanda_id = p_comanda_id loop
    insert into atendimentos (estabelecimento_id, cliente_id, estabelecimento_atividade_id, profissional_id, data_atendimento, origem)
    values (v_comanda.estabelecimento_id, v_comanda.cliente_id, v_item.estabelecimento_atividade_id, v_comanda.profissional_id, v_comanda.fechada_em, 'painel');
  end loop;

  if v_comanda.agendamento_id is not null then
    update agendamentos set status = 'concluido' where id = v_comanda.agendamento_id;
  end if;

  return v_comanda;
end;
$$;

-- ============================================================
-- 6. TEMPO REAL — LISTEN/NOTIFY no caixa (blueprint seção 5)
-- ============================================================
create or replace function notificar_caixa_atualizado()
returns trigger language plpgsql as $$
begin
  perform pg_notify('caixa_' || NEW.estabelecimento_id::text, json_build_object(
    'tipo', NEW.tipo, 'valor', NEW.valor, 'hora', NEW.created_at
  )::text);
  return NEW;
end;
$$;

create trigger trg_caixa_notify
after insert on caixa_entradas
for each row execute function notificar_caixa_atualizado();

-- ============================================================
-- 7. RLS EM CASCATA — mesmo padrão do resto do schema
-- ============================================================
alter table agendamentos enable row level security;
create policy "acesso a agendamentos do proprio estabelecimento"
on agendamentos for all
using ( usuario_e_proprietario(estabelecimento_id) );

alter table comandas enable row level security;
create policy "acesso a comandas do proprio estabelecimento"
on comandas for all
using ( usuario_e_proprietario(estabelecimento_id) );

alter table comanda_itens enable row level security;
create policy "acesso a itens de comanda do proprio estabelecimento"
on comanda_itens for all
using ( exists (
  select 1 from comandas c where c.id = comanda_id and usuario_e_proprietario(c.estabelecimento_id)
) );

alter table caixa_entradas enable row level security;
create policy "acesso ao caixa do proprio estabelecimento"
on caixa_entradas for all
using ( usuario_e_proprietario(estabelecimento_id) );
