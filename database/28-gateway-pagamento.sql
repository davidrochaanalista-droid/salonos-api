-- SalonOS — Migração 28: gateway de pagamento Pix (baixa automática de comanda)
-- Rodar depois de 27.
--
-- gateway_credenciais_criptografadas guarda um JSON cifrado (AES-256-GCM
-- via src/lib/crypto.js, mesmo helper já usado em clientes.observacoes_
-- criptografadas) com o formato certo pro provedor escolhido:
--   mercadopago: {access_token, webhook_secret}
--   asaas:       {api_key, webhook_token}
--   efi:         {client_id, client_secret, certificado_base64}
-- Nunca decriptado em resposta de API nenhuma -- só internamente na hora
-- de chamar o provedor (src/lib/gateways/*.js).

alter table estabelecimentos add column gateway_pagamento text
  check (gateway_pagamento in ('mercadopago', 'asaas', 'efi'));
alter table estabelecimentos add column gateway_credenciais_criptografadas text;

create table cobrancas_pix (
  id uuid primary key default gen_random_uuid(),
  estabelecimento_id uuid references estabelecimentos(id) not null,
  comanda_id uuid references comandas(id) not null,
  gateway text not null check (gateway in ('mercadopago', 'asaas', 'efi')),
  cobranca_id_externo text not null,
  valor numeric not null,
  status text not null default 'pendente' check (status in ('pendente', 'pago', 'expirado', 'cancelado')),
  copia_cola text,
  qr_data_url text,
  created_at timestamptz default now(),
  pago_em timestamptz
);
create index idx_cobrancas_pix_comanda on cobrancas_pix (comanda_id);
-- Um webhook precisa achar a cobrança pelo id externo do provedor sem
-- saber o estabelecimento de antemão (a rota já recebe estabelecimentoId
-- na URL, mas o índice ajuda mesmo assim na consulta de confirmação).
create index idx_cobrancas_pix_externo on cobrancas_pix (gateway, cobranca_id_externo);

alter table cobrancas_pix enable row level security;

create policy "cobrancas_pix_acesso_proprio" on cobrancas_pix for all
  using ( usuario_e_proprietario(estabelecimento_id) );
