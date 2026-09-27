-- ============================================================
-- SalonOS — Migração 40: lista de espera em cascata pelo WhatsApp
-- Rodar depois de 39.
--
-- Pedido do David (26/09/2026): quando um horário fica livre (cancelamento
-- ou remarcação), o sistema oferece pelo WhatsApp pro próximo da lista de
-- espera daquele serviço; se ele aceitar, agenda sozinho; se recusar ou não
-- responder em 15 minutos, oferece pro próximo -- e assim sucessivamente,
-- até alguém aceitar ou a fila acabar. Cliente entra na fila pela IA do
-- WhatsApp (quando não tem vaga) ou pela equipe no painel.
--
-- Antes daqui a fila só notificava o 1º e parava (atendente confirmava na
-- mão) -- ver dispararListaEspera antigo em routes/agenda.js.
-- ============================================================

-- atendido_em: ganhou um horário pela fila -> sai da fila. Quem recusa uma
-- oferta continua na fila pras próximas vagas.
alter table lista_espera add column if not exists atendido_em timestamptz;
alter table lista_espera add column if not exists origem text not null default 'painel'
  check (origem in ('painel', 'whatsapp'));

-- Uma linha por oferta enviada. vaga_id agrupa as ofertas do MESMO horário
-- liberado (pra nunca oferecer duas vezes a mesma vaga pro mesmo cliente e
-- saber quem é o próximo da cascata). Dados do horário ficam copiados em
-- cada linha -- a cascata continua a partir da última oferta.
create table if not exists ofertas_horario_vago (
  id uuid primary key default gen_random_uuid(),
  vaga_id uuid not null,
  estabelecimento_id uuid references estabelecimentos(id) not null,
  lista_espera_id uuid references lista_espera(id) on delete cascade not null,
  cliente_id uuid references clientes(id) not null,
  estabelecimento_atividade_id uuid references estabelecimento_atividades(id) not null,
  profissional_id uuid references profissionais(id),
  inicio timestamptz not null,
  fim timestamptz not null,
  cliente_que_liberou_id uuid references clientes(id), -- nunca recebe a oferta da própria vaga
  status text not null default 'pendente'
    check (status in ('pendente', 'aceita', 'recusada', 'expirada', 'cancelada')),
  enviada_em timestamptz not null default now(),
  expira_em timestamptz not null,
  respondida_em timestamptz,
  agendamento_id uuid references agendamentos(id),
  created_at timestamptz default now()
);
create index if not exists idx_ofertas_vago_pendentes on ofertas_horario_vago (status, expira_em);
create index if not exists idx_ofertas_vago_cliente on ofertas_horario_vago (cliente_id, status);
create index if not exists idx_ofertas_vago_vaga on ofertas_horario_vago (vaga_id);

-- Backend (webhook/scheduler) grava com service_role; painel só lê.
alter table ofertas_horario_vago enable row level security;
create policy "leitura das ofertas do proprio estabelecimento" on ofertas_horario_vago for select
  using ( usuario_e_proprietario(estabelecimento_id) );
