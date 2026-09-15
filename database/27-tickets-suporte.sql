-- SalonOS — Migração 27: central de suporte (tickets)
-- Rodar depois de 26.
--
-- Dono do salão abre chamado e vê só os próprios (usuario_e_proprietario,
-- mesmo padrão do resto do schema); leitura/resposta geral (cross-tenant)
-- só via admin (David, painel-admin), mesmo padrão de admins/sou_admin()
-- já usado em auditoria_acessos.

create table tickets_suporte (
  id uuid primary key default gen_random_uuid(),
  estabelecimento_id uuid references estabelecimentos(id) not null,
  proprietario_id uuid references proprietarios(id) not null,
  assunto text not null,
  mensagem text not null,
  prioridade text not null default 'media' check (prioridade in ('baixa', 'media', 'alta')),
  status text not null default 'aberto' check (status in ('aberto', 'respondido', 'resolvido')),
  resposta_admin text,
  created_at timestamptz default now(),
  respondido_em timestamptz
);
create index idx_tickets_estabelecimento on tickets_suporte (estabelecimento_id, created_at desc);

alter table tickets_suporte enable row level security;

create policy "tickets_select_proprio" on tickets_suporte for select
  using ( usuario_e_proprietario(estabelecimento_id) or sou_admin() );

create policy "tickets_insert_proprio" on tickets_suporte for insert
  with check ( usuario_e_proprietario(estabelecimento_id) );

-- Update (responder/mudar status) só admin -- o dono não edita a própria
-- mensagem depois de aberta, só acompanha.
create policy "tickets_update_admin" on tickets_suporte for update
  using ( sou_admin() );
