# SalonOS API — Contexto do projeto

## O que é

Backend do SalonOS (gestão de salão de beleza/estética + IA de atendimento no
WhatsApp). Node/Express + Supabase (Postgres com RLS). Documentação de
arquitetura e estratégia em `docs/`; migrações SQL em `database/`; painéis
HTML (frontend) em `public/`.

## Estado em 13/09/2026 — motor de automações + frontend 100% religado

Ponto de partida do dia: backend operacional (agenda/comanda/caixa) pronto,
mas as 3 telas do frontend ainda tinham dado mockado misturado com o real, e
ninguém tinha testado login de verdade pelo navegador servido pelo próprio
backend. Histórico detalhado de commits anteriores em `git log` — este
arquivo documenta só o estado atual, não um changelog completo.

### Frontend 100% real (nada de `const D = {...}` mockado sobrevive)

`salon-v6.html` e `painel-proprietario.html`: login real (Supabase Auth),
agenda/clientes/comanda/caixa/relatórios/equipe/config ligados a endpoint
real. Toda seção sem endpoint real (Estoque, listagem de Avaliações,
Marketplace, IA Preditiva, WhatsApp Flows) mostra estado vazio "em breve" —
nunca número inventado. A aba "Plano" (assinatura do salão com a SalonOS)
foi removida do painel do salão por decisão do usuário — isso é assunto do
painel de admin/desenvolvedor, não do dono do salão.

### ⚠️ Gotcha de CSP — ler antes de mexer em qualquer `public/*.html`

O `helmet()` em `src/server.js` tem CSP customizado
(`script-src 'unsafe-inline' https://cdn.jsdelivr.net`,
`script-src-attr 'unsafe-inline'`, `connect-src https://*.supabase.co
wss://*.supabase.co`). Sem isso, o `<script>` inline inteiro de qualquer
página em `public/` é bloqueado silenciosamente — nenhum JS roda, nenhum
erro aparece na UI, só uma rejeição de CSP no console do navegador. Esse bug
ficou invisível por dias porque ninguém tinha testado login pelo próprio
servidor Express antes (as páginas HTML nunca eram servidas por ele até
`express.static('public')` ser adicionado). Se algum dia essas páginas
virarem JS em arquivo separado com nonce, dá pra apertar o CSP de novo.

### ⚠️ Gotcha de RLS — tabela nova precisa de policy explícita

`proprietarios` tinha `relrowsecurity=true` mas **nenhuma policy**, o que
bloqueia TODO acesso via API (inclusive o dono lendo o próprio registro) —
só escapava via SQL Editor (roda como superusuário). RLS habilitado sem
nenhuma policy = acesso zero pra todo mundo exceto owner do banco. Sempre
que uma tabela nova ganhar RLS, criar a policy na mesma migração.

### Motor de automações (`database/14-motor-automacoes.sql`)

7 tipos: `confirmacao_24h`, `reativacao_clientes`, `aniversario`,
`retorno_ciclo`, `upsell_agendamento`, `lista_espera`,
`avaliacao_pos_atendimento` (esse já existia via `fechar_comanda`, só passou
a aparecer na listagem). Os 4 primeiros rodam num scheduler periódico
(`src/lib/automacoes/scheduler.js`, a cada 15min); os outros 2 disparam
inline nas próprias rotas de agenda (reação imediata a criar/cancelar
agendamento). Dedupe e métrica real de "disparos" via tabela
`automacao_disparos`. Toda automação nasce **desativada** por estabelecimento
(dono liga na aba Automações), exceto avaliação pós-atendimento.
`lista_espera` é cadastro manual do atendente — não existe agendamento
self-service pelo cliente ainda.

**Não testado ponta a ponta com WhatsApp real** — `enviarMensagemWhatsApp`
loga e não envia nada enquanto `EVOLUTION_API_URL/INSTANCE/KEY` não
estiverem configurados (ver pendência do Railway abaixo).

### Estoque completo (`database/15-estoque-receitas.sql`, `16-fechar-comanda-baixa-estoque.sql`)

Produtos com quantidade/custo/estoque mínimo (alerta visual quando abaixo do
mínimo), "receita" por serviço (`estabelecimento_atividade_produtos` — quanto
de cada produto um serviço consome por atendimento), e baixa automática no
estoque dentro do próprio `fechar_comanda` (mesmo momento em que
atendimentos/caixa são gravados). Cadastro de produto aceita foto opcional;
Groq vision (`GROQ_VISION_MODEL`) tenta pré-preencher marca/descrição/
validade como sugestão — nunca salva sozinho, sempre exige confirmação
manual no formulário. Testado ponta a ponta no navegador (cadastro, receita,
fechamento de comanda com baixa exata, alerta de mínimo). **Não testado**: o
fluxo de identificação por foto com uma imagem real (sem câmera disponível
no ambiente de teste) — a chamada à API da Groq segue o mesmo padrão já
validado em `whatsapp.js`, mas o formato exato da resposta multimodal não
foi confirmado com uma requisição real.

### Aba Serviços (edição de preço/duração/ciclo de retorno)

Nova aba no `salon-v6.html` — antes não existia NENHUMA UI pra editar um
serviço depois do cadastro inicial (só dava pra ver preço em dropdowns de
agenda/comanda). Lista os serviços do salão, clique abre modal com
nome/preço/duração/ciclo de retorno (dias)/ativo, salva via `PATCH
/atividades/:id` (rota já existia, só faltava o front). É aqui que o dono
configura `ciclo_recompra_dias`, usado pela automação "Retorno por Ciclo".
Testado no navegador (editar Corte Feminino, ciclo 45 dias, persistiu).

### Conta de teste

Existe um estabelecimento de teste ("Studio Teste QA") no Supabase de
produção, criado nesta sessão pra QA manual no navegador, logado com a
mesma conta usada no cadastro real (`davidrocha.coitinho@gmail.com`).
Credenciais não ficam neste arquivo — perguntar ao usuário se precisar.

## Pendências reais restantes

1. **Evolution API/Railway — ainda bloqueado**: trial do Railway expirado,
   precisa de plano pago pra provisionar (confirmado de novo em 13/09 via
   `railway init`: "Your trial has expired. Please select a plan to
   continue using Railway." — bloqueia até escolher plano, não dá pra
   contornar por código). Sem isso, nem o gatilho de avaliação nem o motor
   de automações enviam mensagem de verdade (só logam). Template pronto no
   marketplace do Railway quando for a hora: `railway deploy -t
   evolution-api-4`. O próprio `salonos-api` também nunca foi deployado.
   CLI já está instalado e autenticado (`davidrocha.analista@gmail.com`).
   Tentativa alternativa em 13/09 com Z-API (id/token/client-token de um
   salão de teste) esbarrou em assinatura bloqueada da instância
   ("subscribe to this instance again") — não é um problema de código,
   ficou só confirmado que autenticação Z-API (header `Client-Token`) segue
   o padrão esperado. Decisão: manter Evolution API como plano de produção
   (multi-salão numa instância só sai muito mais barato que Z-API, que
   cobra assinatura por número conectado).
2. **Conexão de WhatsApp por salão + importação de contatos** — escopado e
   construído em 13/09 (`database/17-whatsapp-conexao.sql`,
   `src/lib/evolution-api.js`, `src/routes/whatsapp-conexao.js`, aba
   WhatsApp em `salon-v6.html`), mas **⚠️ não testado contra uma instância
   real** — bloqueado pelo item 1 acima. Modelo: um único serviço Railway do
   Evolution API, **uma instância por salão** (`salon_{estabelecimento_id}`,
   substituiu a `EVOLUTION_INSTANCE` fixa do `.env` — `enviarMensagemWhatsApp`
   e todo mundo que a chama agora passam `estabelecimentoId`). Fluxo: dono
   clica "Conectar WhatsApp" → modal com QR code (webhook sincroniza
   `estabelecimentos.whatsapp_status`/`whatsapp_numero` via evento
   `connection.update`) → depois de conectado, "Importar contatos" busca os
   contatos salvos no celular (`findContacts` do Evolution) numa tela de
   revisão com checkbox antes de virar `clientes` de verdade — decisão
   consciente de não importar automaticamente pra não misturar contato
   pessoal do dono com cliente real do salão. Nomes de endpoint/payload da
   Evolution API v2 foram escritos de memória (não verificados) — primeira
   coisa a conferir/ajustar assim que existir uma instância real pra testar.
3. **IA Preditiva / Marketplace / WhatsApp Flows (editor visual de
   conversa)** — placeholders "em breve", cada um exigiria decisão de
   produto própria antes de construir (não é só "religar fio").
4. **Rastreabilidade de lote de insumo** (Eixo 3, clínica de estética
   pequena) — não implementado.
5. **`painel-admin.html`** — continua fora de escopo (console interno da
   SalonOS, não do salão).

## Ordem sugerida pra continuar

1. Resolver o plano do Railway, provisionar Evolution API + deployar o
   `salonos-api` (bloqueio raiz de várias pendências) — David está
   resolvendo isso (13/09)
2. Testar WhatsApp ponta a ponta com número real (conexão QR, importação
   de contatos, gatilho de avaliação, as 4 automações do scheduler e os 2
   gatilhos inline)
3. Decidir se IA Preditiva/Marketplace entram no roadmap ou saem de vez do
   menu
