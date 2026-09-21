-- ============================================================
-- SalonOS — Migração 33: marcação automática de no-show
-- Rodar depois de 32.
--
-- Fecha um gap real: um agendamento que passou do horário (fim) sem
-- check-in ficava 'agendado'/'confirmado' pra sempre — não existia job
-- nenhum que virasse 'nao_compareceu' sozinho. A IA do WhatsApp já
-- avisa o cliente com histórico de falta que vai precisar de sinal
-- antecipado (LIMITE_FALTAS_SINAL, src/routes/whatsapp.js), mas
-- "histórico de falta" só existia se alguém marcasse na mão no painel.
--
-- Substitui 2 arquivos soltos na raiz do repo
-- (05-migracao-agendamentos.sql, 06-migracao-no-show-automatico.sql,
-- 21/09/2026) escritos contra um schema DIFERENTE do real — assumiam
-- uma tabela `agendamentos` própria (colunas data_horario/
-- valor_previsto/politica_pagamento_id, status 'pendente'/'no_show'),
-- quando a tabela real já existe desde a migração 05 de verdade
-- (colunas inicio/fim, status já inclui 'nao_compareceu'). O arquivo
-- solto 05 chegou a rodar no SQL Editor e quebrou (create table if not
-- exists é no-op contra a tabela real já existente, então só o create
-- index numa coluna que não existe tentou rodar de verdade, e falhou);
-- o solto 06 "rodou sem erro" mas só criou uma função morta — Postgres
-- não valida coluna referenciada dentro do corpo de uma função plpgsql
-- até ela ser CHAMADA, e ela nunca funcionaria (politicas_pagamento
-- nunca chegou a existir). Essa migração aqui é a versão certa, contra
-- o schema real, e substitui (create or replace) a função morta pela
-- de verdade.
-- ============================================================

-- Taxa flat por estabelecimento — mesmo padrão simples já usado por
-- gateway_pagamento (migração 28): sem tabela de "políticas" nomeadas
-- separada, que seria complexidade sem nenhum uso hoje (SalonOS não
-- tem múltiplas políticas por estabelecimento em lugar nenhum do
-- produto real). Null = sem taxa configurada, no-show só muda o status.
alter table estabelecimentos add column if not exists taxa_no_show_pct numeric
  check (taxa_no_show_pct is null or (taxa_no_show_pct >= 0 and taxa_no_show_pct <= 100));

-- Valor CALCULADO no momento em que marca — nunca cobra nada sozinha
-- (SalonOS não tem gateway ligado a agendamento futuro, só à comanda
-- via cobrancas_pix, migração 28). Só registra pro dono ver no painel
-- e cobrar por fora, mesmo modelo já usado pro sinal antecipado
-- combinado na conversa via WhatsApp.
alter table agendamentos add column if not exists taxa_no_show numeric;

create or replace function marcar_agendamentos_no_show(p_tolerancia_horas int default 2)
returns int
language plpgsql
security definer
as $$
declare
  v_marcados int;
begin
  with vencidos as (
    select
      a.id,
      case
        when e.taxa_no_show_pct is not null and ea.preco is not null and not coalesce(ea.preco_variavel, false)
          then round(ea.preco * (e.taxa_no_show_pct / 100), 2)
        else null
      end as taxa
    from agendamentos a
    join estabelecimentos e on e.id = a.estabelecimento_id
    join estabelecimento_atividades ea on ea.id = a.estabelecimento_atividade_id
    where a.status in ('agendado', 'confirmado')
      and a.fim < (now() - (p_tolerancia_horas || ' hours')::interval)
  )
  update agendamentos a
  set status = 'nao_compareceu', taxa_no_show = v.taxa
  from vencidos v
  where a.id = v.id;

  get diagnostics v_marcados = row_count;
  return v_marcados;
end;
$$;

comment on function marcar_agendamentos_no_show is
  'Marca como nao_compareceu todo agendamento agendado/confirmado cujo '
  'horário (fim) já passou há mais de p_tolerancia_horas. Calcula (nunca '
  'cobra) a taxa de no-show se o estabelecimento tiver taxa_no_show_pct '
  'configurada e o serviço tiver preço fixo (não preco_variavel). '
  'Chamada periodicamente por src/lib/marcarNoShow.js (mesmo padrão dos '
  'outros schedulers do projeto, ver server.js).';
