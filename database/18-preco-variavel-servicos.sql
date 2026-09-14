-- ============================================================
-- SalonOS — Migração 18: preço variável por serviço ("a partir de")
-- Alguns serviços (ex: progressiva) variam muito de preço conforme o
-- caso (tamanho de cabelo, etc.) -- o valor cadastrado vira uma
-- estimativa exibida como "a partir de R$ X" (na tela de Serviços, na
-- Agenda e na IA do WhatsApp), mas o valor real cobrado é digitado na
-- Comanda no momento de fechar, pra não distorcer margem/receita nos
-- relatórios (ver src/routes/comandas.js, preco_unitario já era
-- sobrescrevível, só faltava a UI pra isso).
-- ============================================================

alter table estabelecimento_atividades add column if not exists preco_variavel boolean not null default false;
