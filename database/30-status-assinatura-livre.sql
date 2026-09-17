-- ============================================================
-- SalonOS — Status de assinatura "livre" (cortesia, sem cobrança)
-- ============================================================
-- Pra contas que David quer liberar de graça com acesso total (mesmo
-- nível do plano "escala"), sem passar por "trial" nem contar como
-- receita. `PATCH /admin/contas/:id` força plano='escala' junto
-- sempre que status_assinatura vira 'livre' (ver src/routes/admin.js).

alter table estabelecimentos drop constraint estabelecimentos_status_assinatura_check;
alter table estabelecimentos add constraint estabelecimentos_status_assinatura_check
  check (status_assinatura in ('trial', 'ativo', 'inadimplente', 'cancelado', 'livre'));
