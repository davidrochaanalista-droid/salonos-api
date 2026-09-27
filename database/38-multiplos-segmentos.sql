-- ============================================================
-- SalonOS — Migração 38: estabelecimento com mais de um segmento
-- Rodar depois de 37.
--
-- Pedido do David (26/09/2026): no cadastro o proprietário escolhe mais
-- de um segmento (ex: cabeleireiro + manicure + estética) e pode alterar
-- depois em Config no painel do salão.
--
-- Por que array e não tabela de ligação: estabelecimentos já tem FK
-- direta pra segmentos (segmento_id); uma tabela de ligação criaria um
-- segundo caminho estabelecimentos<->segmentos e o PostgREST passaria a
-- recusar os embeds `segmentos(nome)` que já existem (ambiguidade de
-- relacionamento). Array na mesma linha herda o RLS de estabelecimentos
-- sem policy nova; a API valida que cada id existe e está ativo.
--
-- segmento_id continua existindo como segmento PRINCIPAL (sempre o
-- primeiro de segmentos_ids, mantido pela API) -- nada que já lê
-- segmento_id quebra.
-- ============================================================

alter table estabelecimentos add column if not exists segmentos_ids uuid[];

-- Estabelecimentos existentes: a lista começa só com o segmento que já tinham.
update estabelecimentos
set segmentos_ids = array[segmento_id]
where segmentos_ids is null or cardinality(segmentos_ids) = 0;
