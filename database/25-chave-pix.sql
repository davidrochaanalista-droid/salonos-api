-- SalonOS — Migração 25: chave Pix solta (pagamento antecipado, sem gateway)
-- Rodar depois de 24.
--
-- Sem valor fixo em lugar nenhum do sistema (a IA/painel geram o BR Code
-- sem transactionAmount) -- quem decide o valor do sinal continua sendo
-- a equipe combinando com o cliente, mesmo princípio já em produção.
-- Sem confirmação automática possível com chave solta -- ver migração 28
-- pra quem quiser isso de verdade (precisa de gateway).

alter table estabelecimentos add column chave_pix text;
