-- ============================================================
-- SalonOS — Migração 24: agendamento self-service com múltiplos
-- serviços na mesma visita (WhatsApp)
-- Rodar depois de 20.
--
-- solicitacoes_agendamento continua uma linha por serviço (não vira
-- header+itens) -- grupo_id só agrupa as linhas de um mesmo pedido do
-- cliente (ex: unhas + cabelo + depilação = 3 linhas, mesmo grupo_id).
-- Sem default: a aplicação sempre define explicitamente; grupo_id NULL
-- = pedido antigo/avulso de um serviço só, continua funcionando igual.
--
-- origem_proposta distingue proposta feita pela equipe (fluxo já
-- existente, propor-horario) de proposta buscada automaticamente pela
-- IA (fluxo novo, buscar_horarios_disponiveis) -- o comportamento ao
-- cliente recusar é diferente entre os dois (equipe: volta pra
-- pendente pra tentar de novo; busca automática: fica recusado,
-- terminal, uma nova busca é só uma nova mensagem natural).
-- ============================================================

alter table solicitacoes_agendamento add column grupo_id uuid;
alter table solicitacoes_agendamento add column origem_proposta text check (origem_proposta in ('equipe', 'busca_automatica'));
create index idx_solicitacoes_grupo on solicitacoes_agendamento (grupo_id);
