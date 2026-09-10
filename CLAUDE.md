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

### Não feito nesta sessão (decisão consciente, não esquecimento)

1. **Confirmar que as migrações rodaram no Supabase real** — usuário não
   tinha certeza se já rodou o schema. Ordem completa documentada no
   `README-api.md`, seção "Rodando as migrações no Supabase". **Ninguém
   validou isso ainda** — próxima sessão deveria confirmar antes de
   qualquer teste end-to-end.
2. **Servidor Evolution API não está provisionado** — o código de envio
   está pronto, mas precisa de uma instância rodando (Railway, mesmo padrão
   de deploy já usado no projeto) e as três env vars preenchidas.
3. **Frontend das 3 telas operacionais não foi religado** —
   `painel-admin.html`, `painel-proprietario.html`, `salon-v6.html` continuam
   com login fake e `const D = {...}` mockado. Motivo de não ter sido feito
   nesta sessão:
   - `painel-admin.html` **não é um painel de salão** — é o console interno
     da própria SalonOS (contas de clientes da plataforma, MRR/churn de
     assinatura, suporte, auditoria). Exigiria um subsistema de billing
     interno + papel de admin que não existe no schema. Fora do escopo do
     diagnóstico original (que era sobre o produto voltado ao salão).
   - `painel-proprietario.html` mistura métricas reais computáveis (receita,
     margem, ticket médio, top serviços, comissão por profissional — tudo
     derivável de `comandas`/`comanda_itens`/`profissionais` agora que
     existem) com conceitos que **não existem em lugar nenhum do produto**:
     `mrr` (quanto o salão paga de assinatura à SalonOS — billing da
     plataforma), `rating` (nota de satisfação — sem tabela de avaliação),
     `tax_retorno` (retenção — precisaria de análise de coorte sobre
     `atendimentos`), `meta_mes` (meta do dono — sem conceito de "meta" no
     schema). Religar isso de verdade exige decidir se esses conceitos
     entram no produto (e como) antes de ligar o fio.
   - Nenhuma dessas telas tem cobertura de teste automatizado — só dá pra
     validar rodando contra Supabase real com dado real, e esta sessão não
     tinha credenciais para isso. Reescrever um arquivo de 76-140KB às
     cegas, sem forma de verificar, não é um risco que valha a pena correr.
4. **WebSocket/SSE pro "ao vivo" real** — o trigger `pg_notify` existe, mas
   nada do lado do servidor assina o canal `LISTEN` nem repassa pro
   navegador. Os painéis continuam com `setInterval` fake até isso existir.
5. **Rastreabilidade de lote de insumo** (Eixo 3 da estratégia, nicho de
   clínica de estética pequena) — não implementado, seria uma migração nova.

### Ordem sugerida pra continuar

1. Confirmar/rodar as migrações no Supabase real (item 1 acima)
2. Provisionar Evolution API e testar o fluxo de WhatsApp ponta a ponta
   contra o DVWA... digo, contra um número de teste real
3. Decidir o escopo de `painel-proprietario.html` (cortar `mrr`/`rating`/
   `tax_retorno`/`meta_mes` do v1, ou construir os subsistemas que faltam)
   e então religar com credenciais reais pra poder testar no navegador
4. `painel-admin.html` como projeto à parte (billing interno), só depois do
   produto principal validado com salão piloto
5. WebSocket/SSE pro tempo real, depois que a agenda/comanda estiver em uso
   real gerando eventos de caixa
