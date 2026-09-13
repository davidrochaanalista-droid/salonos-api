-- ============================================================
-- SalonOS — Migração 14: motor de automações (WhatsApp por gatilho)
-- 7 tipos: confirmacao_24h, reativacao_clientes, aniversario,
-- avaliacao_pos_atendimento (já existe via fechar_comanda, só passa a
-- aparecer na listagem), retorno_ciclo, upsell_agendamento, lista_espera.
-- Ver docs da automação em src/lib/automacoes/scheduler.js e nos
-- gatilhos inline em src/routes/agenda.js.
-- ============================================================

create table automacoes (
  id uuid primary key default gen_random_uuid(),
  estabelecimento_id uuid references estabelecimentos(id) not null,
  tipo text not null check (tipo in (
    'confirmacao_24h', 'reativacao_clientes', 'aniversario',
    'avaliacao_pos_atendimento', 'retorno_ciclo', 'upsell_agendamento',
    'lista_espera'
  )),
  ativa boolean not null default false,
  configuracao jsonb not null default '{}', -- ex: {"dias_inatividade": 45}
  created_at timestamptz default now(),
  unique(estabelecimento_id, tipo)
);

-- Log de disparos: dedupe (não mandar a mesma mensagem duas vezes) e
-- métrica real de "quantas vezes essa automação disparou" pra UI.
create table automacao_disparos (
  id uuid primary key default gen_random_uuid(),
  automacao_id uuid references automacoes(id) not null,
  estabelecimento_id uuid references estabelecimentos(id) not null,
  cliente_id uuid references clientes(id) not null,
  referencia_id uuid, -- agendamento_id, estabelecimento_atividade_id ou lista_espera.id conforme o tipo; null quando não se aplica
  disparado_em timestamptz default now()
);
create index idx_automacao_disparos_dedupe on automacao_disparos (automacao_id, cliente_id, referencia_id);

-- Ciclo esperado de retorno por serviço (nulo = automação de retorno por
-- ciclo não se aplica a essa atividade).
alter table estabelecimento_atividades add column if not exists ciclo_recompra_dias integer;

-- Lista de espera: cadastro manual pelo atendente (não existe agendamento
-- self-service pelo cliente ainda). Quando um agendamento daquela
-- atividade é cancelado, o primeiro da fila é notificado.
create table lista_espera (
  id uuid primary key default gen_random_uuid(),
  estabelecimento_id uuid references estabelecimentos(id) not null,
  cliente_id uuid references clientes(id) not null,
  estabelecimento_atividade_id uuid references estabelecimento_atividades(id) not null,
  profissional_id uuid references profissionais(id),
  observacao text,
  notificado_em timestamptz,
  created_at timestamptz default now()
);
create index idx_lista_espera_fila on lista_espera (estabelecimento_id, estabelecimento_atividade_id, notificado_em, created_at);

alter table automacoes enable row level security;
alter table automacao_disparos enable row level security;
alter table lista_espera enable row level security;

create policy "acesso a automacoes do proprio estabelecimento" on automacoes for all
  using ( usuario_e_proprietario(estabelecimento_id) );
create policy "acesso a disparos do proprio estabelecimento" on automacao_disparos for select
  using ( usuario_e_proprietario(estabelecimento_id) );
create policy "acesso a lista de espera do proprio estabelecimento" on lista_espera for all
  using ( usuario_e_proprietario(estabelecimento_id) );
