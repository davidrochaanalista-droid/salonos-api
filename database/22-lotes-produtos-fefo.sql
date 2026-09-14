-- ============================================================
-- SalonOS — Migração 22: rastreabilidade de lote de insumo (FEFO)
-- Rodar depois de 15 e 16.
--
-- Antes: produtos.quantidade_em_estoque era um número único editado
-- direto (PATCH) ou decrementado direto por fechar_comanda. Agora um
-- produto pode ter vários lotes de entrada (numero_lote, quantidade,
-- validade, data_entrada) -- a baixa de estoque no fechamento da
-- comanda passa a consumir o lote que vence primeiro (FEFO), não um
-- lote qualquer. produtos.quantidade_em_estoque continua existindo
-- (usado pelo alerta de estoque mínimo e o resto da UI) mas vira um
-- agregado mantido por trigger = soma de produto_lotes.quantidade_atual.
--
-- Compatibilidade: produto sem nenhum lote cadastrado continua
-- funcionando como antes (PATCH direto em quantidade_em_estoque,
-- baixa direta no fechamento) -- o controle por lote só assume quando
-- o primeiro lote é criado pro produto. Ver dar_baixa_estoque_fefo.
-- ============================================================

create table produto_lotes (
  id uuid primary key default gen_random_uuid(),
  produto_id uuid references produtos(id) not null,
  estabelecimento_id uuid references estabelecimentos(id) not null,
  numero_lote text,
  quantidade_inicial numeric not null,
  quantidade_atual numeric not null,
  validade date,
  data_entrada date not null default current_date,
  custo_unitario numeric,
  created_at timestamptz default now()
);
create index idx_produto_lotes_produto_validade on produto_lotes (produto_id, validade);

alter table produto_lotes enable row level security;
create policy "acesso a lotes do proprio estabelecimento" on produto_lotes for all
  using ( usuario_e_proprietario(estabelecimento_id) );

-- ── Trigger: quantidade_em_estoque do produto = soma dos lotes ──
create or replace function sync_quantidade_estoque_produto()
returns trigger
language plpgsql
as $$
declare
  v_produto_id uuid;
begin
  v_produto_id := coalesce(new.produto_id, old.produto_id);
  update produtos set quantidade_em_estoque = (
    select coalesce(sum(quantidade_atual), 0) from produto_lotes where produto_id = v_produto_id
  ) where id = v_produto_id;
  return null;
end;
$$;

create trigger trg_sync_estoque_produto
after insert or update or delete on produto_lotes
for each row execute function sync_quantidade_estoque_produto();

-- ── Baixa de estoque por FEFO (first-expire-first-out) ──
-- Sem lote cadastrado ainda: cai no comportamento legado (decrementa
-- quantidade_em_estoque direto). Com lote: consome do que vence mais
-- cedo primeiro; se os lotes não cobrirem a quantidade pedida, deixa
-- negativo no último lote consumido em vez de travar o fechamento --
-- mesmo princípio já documentado na migração 16 (alerta visual, não
-- trava dura).
create or replace function dar_baixa_estoque_fefo(p_produto_id uuid, p_quantidade numeric)
returns void
language plpgsql security definer
as $$
declare
  v_restante numeric := p_quantidade;
  v_lote record;
  v_baixa numeric;
  v_tem_lote boolean;
  v_ultimo_lote_id uuid;
begin
  select exists(select 1 from produto_lotes where produto_id = p_produto_id) into v_tem_lote;

  if not v_tem_lote then
    update produtos set quantidade_em_estoque = quantidade_em_estoque - p_quantidade
    where id = p_produto_id;
    return;
  end if;

  for v_lote in
    select id, quantidade_atual from produto_lotes
    where produto_id = p_produto_id and quantidade_atual > 0
    order by validade nulls last, data_entrada
    for update
  loop
    exit when v_restante <= 0;
    v_baixa := least(v_lote.quantidade_atual, v_restante);
    update produto_lotes set quantidade_atual = quantidade_atual - v_baixa where id = v_lote.id;
    v_restante := v_restante - v_baixa;
    v_ultimo_lote_id := v_lote.id;
  end loop;

  if v_restante > 0 then
    if v_ultimo_lote_id is null then
      select id into v_ultimo_lote_id from produto_lotes
      where produto_id = p_produto_id
      order by validade nulls last, data_entrada desc
      limit 1;
    end if;
    update produto_lotes set quantidade_atual = quantidade_atual - v_restante
    where id = v_ultimo_lote_id;
  end if;
end;
$$;

-- ── fechar_comanda atualizado: baixa por FEFO em vez de UPDATE direto ──
-- Substitui a versão da migração 16 por inteiro (mesma função, só o
-- trecho de baixa de estoque muda -- agora itera a receita de cada
-- item e chama dar_baixa_estoque_fefo por produto, em vez de um único
-- UPDATE...FROM que decrementava tudo de uma vez sem noção de lote).
create or replace function fechar_comanda(p_comanda_id uuid, p_forma_pagamento text)
returns comandas
language plpgsql security definer
as $$
declare
  v_comanda comandas;
  v_totais record;
  v_item record;
  v_receita record;
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

    for v_receita in
      select produto_id, quantidade_usada from estabelecimento_atividade_produtos
      where estabelecimento_atividade_id = v_item.estabelecimento_atividade_id
    loop
      perform dar_baixa_estoque_fefo(v_receita.produto_id, v_receita.quantidade_usada * v_item.quantidade);
    end loop;
  end loop;

  if v_comanda.agendamento_id is not null then
    update agendamentos set status = 'concluido' where id = v_comanda.agendamento_id;
  end if;

  return v_comanda;
end;
$$;
