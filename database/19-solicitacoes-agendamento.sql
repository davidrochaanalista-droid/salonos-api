-- ============================================================
-- SalonOS — Migração 19: solicitação de agendamento fora do horário
-- Quando o cliente pede horário com o salão fechado, a IA do WhatsApp
-- registra o pedido aqui em vez de só conversar sobre isso -- a dona/
-- funcionária vê na Agenda e decide: aceitar como pedido (cria o
-- agendamento de verdade + confirma por WhatsApp) ou propor outro
-- horário (manda WhatsApp com a nova proposta e aguarda resposta do
-- cliente, tratada pela IA na próxima mensagem, ver src/routes/whatsapp.js).
-- ============================================================

create table solicitacoes_agendamento (
  id uuid primary key default gen_random_uuid(),
  estabelecimento_id uuid references estabelecimentos(id) not null,
  cliente_id uuid references clientes(id) not null,
  estabelecimento_atividade_id uuid references estabelecimento_atividades(id),
  pedido_cliente text not null,
  data_hora_solicitada timestamptz,
  data_hora_proposta timestamptz,
  status text not null default 'pendente'
    check (status in ('pendente','aceito','horario_proposto','confirmado','recusado')),
  agendamento_id uuid references agendamentos(id),
  created_at timestamptz default now()
);

create index idx_solicitacoes_estabelecimento on solicitacoes_agendamento (estabelecimento_id, status);

alter table solicitacoes_agendamento enable row level security;

create policy "acesso a solicitacoes do proprio estabelecimento"
on solicitacoes_agendamento for all
using ( usuario_e_proprietario(estabelecimento_id) );
