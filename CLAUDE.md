# SalonOS API — Contexto do projeto

## O que é

Backend do SalonOS (gestão de salão de beleza/estética + IA de atendimento no
WhatsApp). Node/Express + Supabase (Postgres com RLS). Documentação de
arquitetura e estratégia em `docs/`; migrações SQL em `database/`; painéis
HTML (frontend) em `public/`.

## Estado em 10/09/2026 — sessão de fechamento de gaps

Ponto de partida: só o cadastro de estabelecimento (`public/cadastro-real.html`)
falava com o backend de verdade. As telas operacionais (`salon-v6.html`,
`painel-proprietario.html`, `painel-admin.html`) rodavam 100% sobre dado
mockado (`const D = {...}`) com login falso, e faltavam agenda/comanda/caixa
inteiras — nem tabela existia. Ver `docs/README-fase1.md` e
`docs/SalonOS-estrategia-diferenciacao-2026.md` para o diagnóstico completo
que motivou o trabalho desta sessão.

### Feito e testado (`npm test` — 7 testes, todos passando)

- **Schema novo** (`database/05-agenda-comanda-caixa.sql`): `agendamentos`,
  `comandas`, `comanda_itens`, `caixa_entradas` + campos de custo/comissão em
  `estabelecimento_atividades`/`profissionais`. Função `fechar_comanda`
  (SECURITY DEFINER) calcula margem real (preço − desconto − custo insumo −
  comissão), grava caixa e histórico de atendimento automaticamente. Trigger
  `pg_notify` no canal `caixa_<estabelecimento_id>` a cada lançamento (base
  pro "ao vivo" real — falta o listener/WebSocket do lado do servidor, ver
  pendências).
- **Segmentos de saúde regulada desativados** (`database/06-...sql`):
  Nutricionista/Psicologia/Odontologia/Fisioterapia marcados `ativo=false`
  por decisão do usuário (não vender ainda) — `GET /segmentos` já filtra.
  Reversível com um `UPDATE`.
- **Rotas novas**: `agenda.js`, `comandas.js`, `caixa.js`, `relatorios.js`
  (margem real por unidade + ponderada da rede — Eixo 6 da estratégia),
  `profissionais.js` (faltava, mencionado como pendência no README antigo).
- **Criptografia de dado sensível** (`src/lib/crypto.js`, AES-256-GCM):
  `clientes.observacoes_criptografadas` agora é escrita/lida de verdade via
  `PATCH /clientes/:id` (novo endpoint) e `GET /clientes/:id`. Antes o campo
  só existia na coluna e nunca era exposto nem gravável.
- **WhatsApp envia mensagem de verdade**: `enviarMensagemWhatsApp` e
  `extrairMensagem` em `src/routes/whatsapp.js` eram funções vazias/stub —
  implementadas para Evolution API (self-hosted, decisão do usuário). Requer
  `EVOLUTION_API_URL`/`EVOLUTION_INSTANCE`/`EVOLUTION_API_KEY` (ver
  `.env.example`) — **ainda não tem servidor Evolution API provisionado**,
  ver pendências.
- **Bug corrigido**: `MODELO_IA` estava fixo em `llama-3.3-70b-versatile`,
  modelo que saiu do catálogo do Groq (confirmado 404 na mesma conta, achado
  num outro projeto do usuário nesta sessão). Agora configurável via
  `GROQ_MODEL`, padrão `openai/gpt-oss-120b`.
- **Bug corrigido (achado pelo teste automatizado)**: o webhook do WhatsApp
  nunca foi alcançável na URL documentada — `server.js` montava o router em
  `/webhook`, mas a rota interna já era `/webhook/whatsapp/:id`, duplicando
  o prefixo (`/webhook/webhook/whatsapp/...`). Provavelmente nunca funcionou
  em produção, nem quando `enviarMensagemWhatsApp` for implementado do lado
  do provedor.
- **Hardening**: `helmet`, rate limiting (300/15min geral, 60/min no
  webhook), log estruturado (`pino`, redige `Authorization`/`apikey`), testes
  (`jest`+`supertest`, sem bater em rede — env vars dummy via
  `jest.setup.js`), CI (`.github/workflows/ci.yml`).
- **`npm audit`**: 2 vulnerabilidades moderadas em `qs` (dependência
  transitiva do Express 4), sem fix não-breaking disponível — migrar pra
  Express 5 resolveria, não feito (risco de quebra sem cobertura de teste
  pra validar).

### Continuação (mesmo dia) — subsistemas de billing/avaliação/meta

Usuário decidiu **construir os subsistemas** em vez de cortar as métricas do
v1 (opção que eu tinha recomendado, mas ele preferiu ir mais fundo):

- **`database/07-assinatura-avaliacoes-metas.sql`**: `planos_precos`
  (preço mensal configurável por plano — base R$97/crescimento R$197/escala
  R$347, editável sem deploy), `estabelecimentos.status_assinatura`
  (trial/ativo/inadimplente/cancelado, **gerenciado manualmente por
  enquanto**), `avaliacoes` (1 por atendimento, nota 1-5 + comentário),
  `metas_mensais` (meta de receita por estabelecimento/mês).
- **Escopo deliberadamente limitado**: isso é o *modelo de dado* pra
  calcular MRR de verdade (preço configurado × status da assinatura) — **não
  integra cobrança automática** (Stripe/Mercado Pago/etc.). Automatizar
  cobrança é uma decisão de gateway de pagamento separada, que exige conta
  própria e não foi tomada. Documentado explicitamente no topo da migração
  pra não alguém achar, no futuro, que isso já cobra o cliente sozinho.
- **`routes/avaliacoes.js`**: rota pública (`POST /avaliacoes`, sem token)
  porque quem avalia é o cliente do salão, que não tem login — usa
  `service_role` key + função `registrar_avaliacao` (SECURITY DEFINER),
  mesmo padrão de exceção do webhook do WhatsApp. **Falta o gatilho que
  manda o link de avaliação pro cliente** (ex.: mensagem automática via
  Evolution API depois de `fechar_comanda`) — o endpoint existe, mas nada
  ainda chama ele na prática.
- **`routes/metas.js`**: CRUD simples de meta mensal por estabelecimento.
- **`routes/relatorios.js` ganhou `GET /estabelecimentos/:id/resumo-mensal`**:
  agrega tudo que `painel-proprietario.html` precisa por unidade — receita,
  margem, ticket médio, receita por semana, MRR, agendamentos do mês,
  retenção (% de clientes com 2+ atendimentos nos últimos 90 dias, definição
  arbitrária, ajustável), rating médio, contagem/comissão por profissional,
  top 3 serviços, e a meta do mês. Isso foi desenhado **especificamente pra
  bater com o formato de `D.saloes[i]`** no HTML, pra quando o frontend for
  religado o adapter ser direto.
- 9 testes passando (2 novos: rota pública de avaliação, rota de metas
  bloqueada sem token).

### Ainda não feito

1. **Confirmar que as migrações rodaram no Supabase real** — usuário não
   tinha certeza. Gerei `database/COMBINADO-rodar-no-supabase.sql`
   (concatena 01+03+04+05+06+07, **não commitado**, é conveniência local
   gitignored) — abrir no VS Code e colar de uma vez no SQL Editor do
   Supabase. **Ninguém validou isso ainda.**
2. **Evolution API/Railway — bloqueado**: o trial do Railway da conta
   expirou, não dá pra criar projeto novo até escolher um plano pago
   (decisão de cobrança, só o usuário pode fazer — `railway init` falhou
   com "Your trial has expired"). Assim que o plano for escolhido: existe
   um template pronto no marketplace (`railway deploy -t evolution-api-4`,
   ~5000 deploys, healthScore 100) — não precisa reconstruir do zero.
3. **Frontend das 3 telas operacionais não foi religado** — mesmo motivo de
   antes (arquivos grandes, zero cobertura de teste automatizado, e agora
   também zero credenciais reais do Supabase pra testar no navegador). A
   diferença é que agora o backend (`resumo-mensal`) já devolve tudo no
   formato certo — religar é mais próximo de "trabalho de encanamento" do
   que "decisão de produto em aberto".
   - `painel-admin.html` continua fora de escopo (console interno da
     SalonOS, não do salão — precisa de papel de admin que não existe).
4. **WebSocket/SSE pro "ao vivo" real** — trigger `pg_notify` existe, falta
   o listener do lado do servidor.
5. **Rastreabilidade de lote de insumo** (Eixo 3, clínica de estética
   pequena) — não implementado.
6. **Gatilho de avaliação** — endpoint existe (`POST /avaliacoes`), mas
   nada dispara o link pro cliente ainda (ver nota acima).

### Ordem sugerida pra continuar

1. Rodar `database/COMBINADO-rodar-no-supabase.sql` no Supabase real
   (gerar esse arquivo de novo se as fontes numeradas mudarem)
2. Resolver o plano do Railway, provisionar Evolution API (`railway deploy
   -t evolution-api-4`) + o próprio `salonos-api` (nunca foi deployado —
   `railway status` não achou projeto linkado)
3. Testar WhatsApp ponta a ponta com um número real
4. Religar `painel-proprietario.html` com credenciais reais do Supabase
   (agora o backend já entrega tudo pronto via `resumo-mensal`)
5. Disparar `POST /avaliacoes` via WhatsApp depois de `fechar_comanda`
6. `painel-admin.html` como projeto à parte, só depois do piloto validado
7. WebSocket/SSE pro tempo real
