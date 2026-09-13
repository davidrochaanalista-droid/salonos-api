-- ============================================================
-- SalonOS — Migração 15: estoque de produtos + receita por serviço
-- "Receita" = quanto de cada produto um serviço consome por atendimento
-- (estabelecimento_atividade_produtos). A baixa automática no fechamento
-- da comanda está na migração 16 (função fechar_comanda).
-- ============================================================

create table produtos (
  id uuid primary key default gen_random_uuid(),
  estabelecimento_id uuid references estabelecimentos(id) not null,
  nome text not null,
  marca text,
  categoria text,
  unidade text not null default 'un', -- ml, g, un, etc
  custo_unitario numeric not null default 0,
  quantidade_em_estoque numeric not null default 0,
  estoque_minimo numeric default 0,
  validade date,
  foto_url text,
  ativo boolean not null default true,
  created_at timestamptz default now()
);
create index idx_produtos_estabelecimento on produtos (estabelecimento_id);

create table estabelecimento_atividade_produtos (
  id uuid primary key default gen_random_uuid(),
  estabelecimento_atividade_id uuid references estabelecimento_atividades(id) not null,
  produto_id uuid references produtos(id) not null,
  quantidade_usada numeric not null,
  unique(estabelecimento_atividade_id, produto_id)
);

alter table produtos enable row level security;
alter table estabelecimento_atividade_produtos enable row level security;

create policy "acesso a produtos do proprio estabelecimento" on produtos for all
  using ( usuario_e_proprietario(estabelecimento_id) );
create policy "acesso a receita do proprio estabelecimento" on estabelecimento_atividade_produtos for all
  using ( exists (
    select 1 from estabelecimento_atividades ea
    where ea.id = estabelecimento_atividade_id and usuario_e_proprietario(ea.estabelecimento_id)
  ) );
