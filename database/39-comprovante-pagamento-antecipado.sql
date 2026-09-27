-- ============================================================
-- SalonOS — Migração 39: comprovante de pagamento antecipado (Pix)
--                        + sinal de remarcação
-- Rodar depois de 38.
--
-- Pedido do David (26/09/2026): depois de confirmar o horário, a IA do
-- WhatsApp oferece (de leve) pagar antecipado pelo Pix; se o cliente
-- pagar e mandar o comprovante, a IA lê a imagem (modelo de visão da
-- Groq), e se o valor lido bater com o preço do(s) serviço(s), marca o
-- agendamento como pago na agenda. Valor menor/ilegível: guarda o
-- comprovante e deixa a equipe conferir -- nunca marca pago no escuro.
--
-- ⚠️ "Pago" aqui = comprovante lido pela IA, NÃO confirmação bancária
-- (Pix solto não tem retorno do banco). A imagem fica guardada pro dono
-- conferir no próprio banco se quiser.
-- ============================================================

alter table agendamentos add column if not exists comprovante_recebido_em timestamptz;
alter table agendamentos add column if not exists comprovante_valor_lido numeric;
alter table agendamentos add column if not exists comprovante_path text;   -- caminho no bucket 'comprovantes'
alter table agendamentos add column if not exists pago_antecipado_em timestamptz; -- só preenchido se o valor lido bateu

-- Remarcação pelo WhatsApp (mesmo dia, pedido do David): remarcar exige
-- um sinal (30% do preço -- a IA só fala o valor em reais). Fluxo sem
-- aprovação da equipe: cliente pede -> IA informa o sinal e manda o Pix
-- (solicitar_remarcacao) -> comprovante lido com valor >= sinal marca
-- sinal_remarcacao_pago_em -> IA move o PRÓPRIO agendamento pro novo
-- horário se estiver livre (remarcar_agendamento). Ver src/lib/remarcacao.js.
alter table agendamentos add column if not exists remarcacao_solicitada_em timestamptz;
alter table agendamentos add column if not exists sinal_remarcacao_valor numeric;
alter table agendamentos add column if not exists sinal_remarcacao_pago_em timestamptz;

-- Bucket PRIVADO: só o backend (service_role) grava e gera link assinado
-- de curta duração (GET /agendamentos/:id/comprovante, depois de o RLS de
-- agendamentos confirmar que quem pede é dono/login do salão). Sem policy
-- de storage pra usuário comum de propósito -- ninguém lê direto do bucket.
insert into storage.buckets (id, name, public)
values ('comprovantes', 'comprovantes', false)
on conflict (id) do nothing;
