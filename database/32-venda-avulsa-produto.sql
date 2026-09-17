-- ============================================================
-- SalonOS — Migração 32: venda avulsa de produto no balcão
-- ============================================================
-- Até aqui, produtos só existiam como insumo consumido pela receita de
-- um serviço (baixa automática no fechamento de comanda, migração 16/22).
-- Não havia como vender um produto de revenda direto no balcão, fora de
-- uma comanda de serviço. preco_venda é opcional -- fica null pra
-- produtos que são só insumo interno (nunca vendidos avulsos); um
-- produto só pode ser vendido avulso (vender_produto_avulso abaixo)
-- quando tem preco_venda cadastrado.

alter table produtos add column if not exists preco_venda numeric;

-- Reaproveita dar_baixa_estoque_fefo (migração 22) pra consumir o
-- estoque pelo mesmo critério (lote que vence primeiro) já usado no
-- fechamento de comanda -- mesmo princípio de "alerta visual, não trava
-- dura" se a quantidade pedida for maior que o estoque disponível.
create or replace function vender_produto_avulso(p_produto_id uuid, p_quantidade numeric, p_forma_pagamento text)
returns caixa_entradas
language plpgsql security definer
as $$
declare
  v_produto record;
  v_valor numeric;
  v_entrada caixa_entradas;
begin
  select estabelecimento_id, nome, preco_venda into v_produto from produtos where id = p_produto_id;
  if v_produto is null then
    raise exception 'Produto não encontrado.';
  end if;
  if v_produto.preco_venda is null then
    raise exception 'Esse produto não tem preço de venda cadastrado -- edite o produto antes de vender avulso.';
  end if;
  if p_quantidade is null or p_quantidade <= 0 then
    raise exception 'Quantidade precisa ser maior que zero.';
  end if;

  v_valor := v_produto.preco_venda * p_quantidade;

  perform dar_baixa_estoque_fefo(p_produto_id, p_quantidade);

  insert into caixa_entradas (estabelecimento_id, tipo, valor, forma_pagamento, descricao)
  values (v_produto.estabelecimento_id, 'entrada', v_valor, p_forma_pagamento, 'Venda balcão: ' || p_quantidade || 'x ' || v_produto.nome)
  returning * into v_entrada;

  return v_entrada;
end;
$$;
