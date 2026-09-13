-- ============================================================
-- SalonOS — Migração 12: liga atendimentos à comanda que os gerou
-- Objetivo: depois de fechar_comanda, a rota POST /comandas/:id/fechar
-- precisa saber quais atendimentos foram criados para disparar o link
-- de avaliação por WhatsApp -- sem essa coluna só dava pra achar isso
-- por heurística de cliente_id + data_atendimento.
-- ============================================================

alter table atendimentos add column if not exists comanda_id uuid references comandas(id);
create index if not exists idx_atendimentos_comanda on atendimentos (comanda_id);

create or replace function fechar_comanda(p_comanda_id uuid, p_forma_pagamento text)
returns comandas
language plpgsql security definer
as $$
declare
  v_comanda comandas;
  v_totais record;
  v_item record;
begin
  select
    coalesce(sum(preco_unitario * quantidade), 0) as total,
    coalesce(sum(custo_insumo_unitario * quantidade), 0) as custo,
    coalesce(sum(preco_unitario * quantidade * comissao_percentual / 100.0), 0) as comissao
  into v_totais
  from comanda_itens where comanda_id = p_comanda_id;

  update comandas set
    status = 'fechada',
    forma_pagamento = p_forma_pagamento,
    valor_total = v_totais.total,
    valor_custo_total = v_totais.custo,
    valor_comissao_total = v_totais.comissao,
    margem = v_totais.total - coalesce(desconto, 0) - v_totais.custo - v_totais.comissao,
    fechada_em = now()
  where id = p_comanda_id
  returning * into v_comanda;

  insert into caixa_entradas (estabelecimento_id, comanda_id, tipo, valor, forma_pagamento, descricao)
  values (v_comanda.estabelecimento_id, v_comanda.id, 'entrada', v_comanda.valor_total - coalesce(v_comanda.desconto, 0), p_forma_pagamento, 'Comanda fechada');

  for v_item in select * from comanda_itens where comanda_id = p_comanda_id loop
    insert into atendimentos (estabelecimento_id, cliente_id, estabelecimento_atividade_id, profissional_id, data_atendimento, origem, comanda_id)
    values (v_comanda.estabelecimento_id, v_comanda.cliente_id, v_item.estabelecimento_atividade_id, v_comanda.profissional_id, v_comanda.fechada_em, 'painel', v_comanda.id);
  end loop;

  if v_comanda.agendamento_id is not null then
    update agendamentos set status = 'concluido' where id = v_comanda.agendamento_id;
  end if;

  return v_comanda;
end;
$$;
