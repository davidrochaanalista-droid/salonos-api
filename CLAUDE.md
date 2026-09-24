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

### IA Preditiva de Receita (`GET /estabelecimentos/:id/previsao-receita`)

Substituiu o placeholder "em breve" — decisão de 13/09 foi rodar o cálculo
**desde o primeiro dia com dado real**, em vez de bloquear até acumular
meses de histórico. Método simples e declarado como tal na UI (não é
modelo estatístico sofisticado): média diária da janela recente (até 30
dias corridos) × 30. Selo de confiança sobe com o volume de histórico
(`insuficiente` <3 dias, `baixa` 3-13, `moderada` 14-59, `boa` 60+), mas o
número aparece desde que haja pelo menos 3 dias de comanda fechada — nunca
fica bloqueado esperando um prazo arbitrário. Testado no navegador: com 1
comanda fechada (histórico <3 dias), mostra corretamente o estado vazio em
vez de inventar uma projeção.

### Deploy em produção (Railway) — 13/09/2026

`salonos-api` e Evolution API deployados de verdade no Railway, projeto
`salonos-api` (workspace `davidrocha.coitinho@gmail.com` — **⚠️ atenção**:
o CLI já logou sozinho na conta errada, `davidrocha.analista@gmail.com`,
várias vezes nesta sessão porque o navegador tinha uma sessão Railway em
cache; usar `railway login --browserless` e confirmar o e-mail no output
se isso acontecer de novo). URLs:
`https://salonos-api-production-7d28.up.railway.app` (backend) e
`https://evolution-api-production-4560.up.railway.app` (Evolution API,
template `evolution-api-4`, vem com Postgres+Redis próprios pra sessão do
WhatsApp — schema separado do banco do SalonOS).

**Dois bugs reais achados só ao testar em produção** (nenhum dos dois
aparecia local, por isso passaram despercebidos a sessão toda):

1. **`API_BASE_URL` fixa em `http://localhost:3001`** em `salon-v6.html`,
   `painel-proprietario.html` e `cadastro-real.html` -- todo `chamarAPI()`
   tentava bater no localhost da máquina do usuário e falhava com "Failed
   to fetch" assim que servido de um domínio de verdade. Corrigido pra
   string vazia (caminho relativo -- funciona em qualquer ambiente, já
   que o Express sempre serve HTML e API na mesma origem).
2. **Node 18 no Railway não tem WebSocket nativo**, e o Realtime do
   `@supabase/supabase-js` exige isso -- processo crashava no boot.
   `package.json` engines bumped pra `>=22`.

**Motor de WhatsApp testado ponta a ponta com número real**: QR code
pareou de verdade (⚠️ QR expira rápido -- em segundos, não minutos; se
demorar pra escanear, gerar um novo). Achado nesse teste: a instância de
teste tinha sido criada manualmente via curl antes do deploy (pra validar
os endpoints), sem webhook configurado -- por isso o pareamento aconteceu
mas nosso banco nunca soube (`whatsapp_status` ficou preso em
"conectando"). Corrigido rodando `POST /webhook/set/:instance` na
instância existente; daqui pra frente toda instância nova já nasce com
webhook configurado (fluxo normal do app, isso só foi necessário pra essa
instância de teste específica).

**Bug real de verdade no `buscarContatosSalvos`** (`src/lib/evolution-api.js`):
o código usava `c.id` como telefone, mas `id` é o id interno do registro
no banco da Evolution (tipo `cmu0l6epl08mjkq5r99jh6zot`), não o número.
O campo certo é `remoteJid`. Sem esse fix, a importação de contatos
trazia **2345 "contatos"** que eram na maioria grupos do WhatsApp (`@g.us`)
com nome de grupo virando "nome de cliente" e um ID aleatório virando
"telefone". Corrigido: filtra `isGroup`, exclui sufixo `@lid` (contato com
identidade vinculada, sem número real exposto -- não tem como extrair
telefone daí) e a conta de sistema `0@s.whatsapp.net`. Com o fix, sobraram
~2087 contatos reais (número de teste era um WhatsApp pessoal de verdade,
não um número virgem -- por isso o volume alto; a tela de revisão com
checkbox existe exatamente pra esse cenário, pra não importar tudo como
cliente sem o dono revisar).

### ⚠️ Incidente real: IA de atendimento respondeu a um contato pessoal

Ao testar a conexão de WhatsApp com um número pessoal real (13/09), um
contato pessoal do David mandou uma mensagem casual pro número conectado
e a IA de onboarding tratou como "cliente novo do salão", perguntando
nome/endereço numa conversa confusa -- criou um cadastro de cliente falso
com o telefone real da pessoa. Causa raiz: o webhook responde
automaticamente a **qualquer** mensagem recebida, sem diferenciar
"cliente de verdade" de "alguém só mandando mensagem pro número". Isso é
o comportamento correto/esperado pro número oficial do salão em produção,
mas é perigoso testar conectando um número pessoal de uso cotidiano --
a IA vai atender quem quer que mande mensagem. Resolvido nesse caso:
desconectado o WhatsApp, apagado o cadastro/mensagens/memória criados
pro contato real. **Lição:** avisar isso antes de qualquer teste futuro
com número pessoal, ou usar um número dedicado só pra teste.

### Motor de tool calling na IA do WhatsApp (13/09/2026)

A IA agora consegue executar ações de verdade, não só gerar texto --
`FERRAMENTAS_IA`/`executarFerramentaIA` em `src/routes/whatsapp.js`
implementam function calling (formato OpenAI, suportado pela Groq).
Primeira ferramenta: `atualizar_cadastro_cliente` (nome/endereço/data de
nascimento), chamada quando o cliente já onboardado pede pra corrigir um
dado. Fluxo: 1ª chamada à Groq com `tools` anexado → se vier
`tool_calls`, executa de verdade no Supabase → manda o resultado de volta
pra Groq numa 2ª chamada → só aí gera o texto final pro cliente. Sem
isso, a IA só conseguiria *dizer* que atualizou sem nunca ter mudado nada
-- mentira pro cliente. Testado isoladamente contra a API real da Groq
(fora do webhook): a IA identificou corretamente a intenção de correção,
chamou a ferramenta com o argumento certo, e gerou a resposta final
depois do resultado real. Não testado ainda dentro do fluxo completo do
webhook (evitado de propósito, pra não repetir o incidente acima).

Também: prompt do sistema revisado pra tom mais caloroso mas objetivo
(máximo 1 emoji por mensagem, mensagens curtas), respostas da IA com mais
de uma ideia são quebradas em mensagens separadas de verdade
(`enviarRespostaIA` separa por parágrafo e manda uma de cada vez, não um
bloco só), pede esclarecimento com gentileza quando não entende, respeita
pedido de parar de receber mensagem, e é transparente se perguntada se é
IA (decisão consciente: **não** esconder por padrão, diferente de uma
sugestão de prompt externa que pedia esconder -- rejeitada por causa do
incidente acima). Cadastro continua exigindo nome + endereço (não só
nome) -- decisão consciente de manter como estava.

### Saudação por horário + aviso de fechado + solicitação de agendamento (13/09/2026)

Três melhorias em sequência no agente do WhatsApp:

1. **Saudação por horário** (`saudacaoPorHorario()`, fuso de Brasília
   sempre, independe de onde o Railway roda) -- "Bom dia"/"Boa
   tarde"/"Boa noite" na mensagem fixa de boas-vindas do onboarding e
   disponível no prompt pra conversa livre. Se o cliente já é cadastrado,
   `nomeCliente` chega no prompt (antes só existia em
   `memoriaCliente.resumo` ou no histórico de 10 mensagens, que pode não
   ter o nome numa conversa antiga) -- a IA cumprimenta pelo primeiro
   nome.
2. **Aviso de horário fechado** (`estaAberto()`, checa
   `dias_funcionamento`/`horario_abertura`/`horario_fechamento`) -- avisa
   uma vez, sem soar como bloqueio, e nunca para de atender.
3. **Solicitação de agendamento de verdade** (migração 19,
   `solicitacoes_agendamento` + `src/routes/solicitacoes-agendamento.js`):
   fecha o loop do item 2 -- antes a IA só *conversava* sobre o pedido
   fora do horário sem salvar nada em lugar nenhum que o painel pudesse
   ver. Agora: IA registra via ferramenta
   `registrar_solicitacao_agendamento` (nunca diz "confirmado", só que a
   equipe vai confirmar) → aba Agenda mostra um bloco "Solicitações Fora
   do Horário" com as pendentes → dona/funcionária **aceita como pedido**
   (cria `agendamentos` de verdade + confirma por WhatsApp) ou **propõe
   outro horário** (WhatsApp gerado pela IA, nunca "responda sim ou não"
   -- ver `gerarMensagemPropostaHorario`) → resposta do cliente à
   proposta é interpretada por uma chamada de IA dedicada com tool
   calling (`FERRAMENTA_RESPOSTA_PROPOSTA`/`tratarRespostaPropostaHorario`,
   sempre linguagem natural) → aceitar cria o agendamento, recusar volta
   pra pendente com a nova preferência anotada.

Migração 19 confirmada rodada em produção. Testado no navegador em
produção (dado fake inserido direto no banco, não via WhatsApp real):
bloco de solicitações aparece na Agenda, "Propor horário" muda o status
pra `horario_proposto` e persiste certo. Ainda não testado dentro do
webhook real (mesmo motivo do tool calling acima -- evitado de propósito
depois do incidente com contato pessoal).

**⚠️ Achado real testando `tratarRespostaPropostaHorario` isolado contra
a Groq**: `tool_choice: 'required'` (e também `'auto'` com instrução
forte) falha uma fração relevante das vezes (~30-50% em teste com a frase
"só depois das 18h") -- às vezes o modelo não chama a ferramenta, às
vezes gera JSON malformado pro argumento (padrão observado: quebra perto
de palavra acentuada tipo "após"). Não é bug de como a ferramenta foi
implementada, é instabilidade do modelo (`openai/gpt-oss-120b` via Groq)
nesse cenário específico. Mitigado com até 2 tentativas + fallback seguro
("vou confirmar com a equipe", sem mudar o status da solicitação) --
nunca deixa o cliente sem resposta nem assume "recusou" sem ter certeza.
Mesmo com o mitigador, uma fração das respostas do cliente ainda cai no
fallback genérico em vez de interpretação instantânea -- se isso incomodar
na prática, considerar trocar `MODELO_IA`/`GROQ_MODEL` nesse tipo de
chamada especificamente, ou revisitar o prompt.

### Profissional + conflito real de agenda + lembrete 2h + sinal por faltas (14/09/2026)

Mais quatro melhorias no motor de agendamento via WhatsApp:

1. **Preferência de profissional na solicitação** (migração 20,
   `profissional_id` em `solicitacoes_agendamento`) -- a IA pergunta
   naturalmente se o cliente tem preferência antes de registrar o pedido
   (ferramenta `registrar_solicitacao_agendamento` ganhou o parâmetro
   `nome_profissional`, mapeado pro id em `executarFerramentaIA`).
2. **Checagem de conflito de verdade** (`src/lib/disponibilidade.js`,
   `buscarConflitoAgendamento`, client-agnóstico -- recebe o supabase
   client por parâmetro porque painel usa `req.supabase` e webhook usa
   `service_role`). Antes o sistema criava o agendamento sem checar nada
   contra a agenda -- agora checa em 3 pontos: aceitar solicitação como
   pedida, propor horário (com seletor de profissional no modal), e
   quando o cliente aceita uma proposta (proteção contra corrida). Sempre
   erro claro (409) em vez de sobrescrever.
3. **Automação "Lembrete 2h antes"** (migração 21, tipo `lembrete_2h`,
   `verificarLembrete2h` em `scheduler.js`, mesmo padrão dedupe das
   outras 7) -- segundo lembrete mais perto do horário, além da
   confirmação 24h, pra reduzir falta sem aviso.
4. **Sinal antecipado pra cliente com histórico de falta**
   (`LIMITE_FALTAS_SINAL = 2` em `whatsapp.js`, sem migração -- conta
   `agendamentos` com `status = 'nao_compareceu'` na hora, não guarda
   flag). Cliente com mais de 2 faltas registradas: a IA avisa no final
   da conversa de agendamento que vai precisar de sinal, mas **não cobra
   nada sozinha** -- só avisa que a equipe vai combinar valor/forma de
   pagamento. Pagamento antecipado de verdade (Pix/cartão) segue como
   pendência separada, ainda não escopada (ver Pendências).

Nenhuma testada dentro do webhook real ainda (mesmo motivo de sempre).
Sintaxe e 17/17 testes conferidos.

### Rastreabilidade de lote (FEFO) + painel-admin.html real (14/09/2026)

David decidiu tocar as duas últimas pendências não-escopadas do dia
(adiando Nota Fiscal e Pagamento Antecipado até validar com donos de
salão -- ver Pendências):

1. **Lote de insumo com dedução FEFO** (migração `database/22-lotes-produtos-fefo.sql`):
   nova tabela `produto_lotes` (numero_lote, quantidade_inicial/atual,
   validade, data_entrada) por produto. `produtos.quantidade_em_estoque`
   virou agregado mantido por trigger (`sync_quantidade_estoque_produto`)
   = soma dos lotes. `fechar_comanda` foi reescrita (mesma migração,
   `create or replace`) pra chamar `dar_baixa_estoque_fefo` por produto
   em vez de decrementar direto -- consome do lote que vence primeiro;
   se não cobrir tudo, deixa negativo no último lote (não trava
   fechamento, mesmo princípio da migração 16). Produto sem lote
   cadastrado ainda cai no comportamento legado (decremento direto).
   Rotas novas em `src/routes/produtos.js`: `GET/POST /produtos/:id/lotes`,
   `PATCH /lotes/:id`, `GET /estabelecimentos/:id/lotes-vencendo`.
   Frontend: `salon-v6.html` ganhou modal "Gerenciar lotes" (a partir do
   modal de editar produto) e badge "vence DD/MM" na lista de estoque
   quando há lote vencendo nos próximos 30 dias.
2. **`painel-admin.html` real**: era 100% mockado (`const D`), login
   fake. Agora: nova tabela `admins` (`database/23-admins.sql`,
   `user_id` + `sou_admin()`) -- separada de `proprietarios` de
   propósito, admin não é dono de salão. Como admin precisa de leitura
   cross-tenant (o que RLS-por-usuário não permite por design), as
   rotas `src/routes/admin.js` (`/admin/me`, `/admin/contas`,
   `/admin/visao`) usam a service_role key via novo middleware
   `src/middleware/exigirAdmin.js` (monta depois de `autenticar`,
   reaproveita `req.user`, 403 se não estiver em `admins`) -- nunca
   `req.supabase`. `doLogin()` agora faz Supabase Auth de verdade +
   confirma admin no backend antes de mostrar qualquer dado. Escopo
   desta entrega: **Contas** e **Visão Geral** mostram dado real
   (estabelecimentos/proprietarios/status_assinatura/planos_precos,
   já existiam desde a migração 07) -- inclusive a lista "contas que
   precisam de atenção" usa `status_assinatura = 'inadimplente'` como
   sinal real (não um "saúde/100" inventado, que existia só no
   protótipo). **Financeiro, Suporte e Auditoria & LGPD ficam "em
   breve"**, decisão explícita: sem gateway de pagamento não há
   transação/fatura real; tabela de ticket é feature nova (fora do
   escopo de "tornar real o que já existe"); log de auditoria real
   exige instrumentar todas as rotas existentes (mudança grande,
   cross-cutting) -- ver Pendências.

**`/code-review high` rodado depois da implementação** (apontado direto
pro path do repo -- a primeira tentativa sem path revisou o repo errado,
achado de tooling registrado à parte) encontrou e foram corrigidos:
XSS armazenado em `painel-admin.html` (nome/cidade/proprietário
interpolados sem escape em innerHTML -- painel de admin é cross-tenant,
achado sério), `PATCH /produtos/:id` sobrescrevendo silenciosamente
`quantidade_em_estoque` de produtos que já têm lote (agora ignora esse
campo nesse caso, já que quem manda é o trigger), aspas simples no nome
do produto quebrando o onclick de "Gerenciar lotes" (mesmo fix de
`nomeSeguro` já usado em `abrirReceitaAtividade`), e `dias=0` sendo
tratado como falsy em `/estabelecimentos/:id/lotes-vencendo`. `npm test`
seguiu 24/24 depois dos fixes.

**Migrações 22 e 23 rodadas e confirmadas em produção** (David rodou no
SQL Editor, confirmado por query direta via service_role: as duas
tabelas existem). Linha de admin em `admins` já inserida
(`davidrocha.coitinho@gmail.com` → `c5dcd01f-8a9e-4f68-9ad4-e7afe5445e75`).
**Ainda não testado no navegador**: fluxo completo de lote (cadastrar 2
lotes com validades diferentes, fechar comanda, confirmar baixa pelo
lote mais próximo do vencimento) e login real no painel-admin.

### Agendamento self-service com múltiplos serviços via WhatsApp (14/09/2026)

David pediu explicitamente pra suportar cliente pedindo vários serviços
na mesma visita (ex: unhas + cabelo + depilação), com o sistema buscando
horário/profissional livres e encaixando tudo em sequência. Isso não
existia de forma nenhuma antes -- nem busca automática de horário livre
(só existia checagem de UM horário já escolhido, `buscarConflitoAgendamento`),
nem suporte a mais de um serviço por pedido.

**Schema** (`database/24-grupo-solicitacao-agendamento.sql`):
`solicitacoes_agendamento` ganhou `grupo_id` (agrupa as linhas de um
mesmo pedido -- continua uma linha por serviço, não virou header+itens)
e `origem_proposta` (`equipe` vs `busca_automatica` -- controla o
comportamento ao cliente recusar, ver abaixo). `grupo_id` null = pedido
antigo/avulso de um serviço só, continua funcionando igual.

**Motor de busca** (`buscarHorariosDisponiveis`, novo em
`src/lib/disponibilidade.js`): varre até 7 dias, grade de 15min, encaixa
os serviços pedidos em sequência (profissional preferido se livre, senão
qualquer profissional ativo -- não existe tabela de especialidade
profissional↔serviço no sistema). **Achado real testando**: a primeira
versão usava `Date.setHours()` (fuso local do processo Node), o que
quebraria em produção porque o Railway não necessariamente roda em
horário de Brasília (mesmo cuidado já documentado em
`estaAberto()`/`saudacaoPorHorario()`) -- corrigido pra construir os
instantes com offset fixo `-03:00` (Brasil não tem mais horário de
verão desde 2019), testado de verdade forçando `TZ=UTC` no processo pra
confirmar que o resultado não muda.

**Dois caminhos, comportamento diferente por decisão explícita do
David**:
- **Salão aberto agora**: nova ferramenta `buscar_horarios_disponiveis`
  -- a IA busca de verdade (nunca inventa horário), propõe, e se o
  cliente aceitar, **agenda direto, sem revisão da equipe** (mudança
  deliberada do princípio "IA nunca confirma sozinha", só pra esse caso).
  Reavalia `estaAberto()` de novo no momento da resposta do cliente (não
  no momento da oferta) -- se ele responder já com o salão fechado, cai
  pro fluxo de equipe em vez de agendar sem ninguém por perto.
- **Salão fechado agora**: `registrar_solicitacao_agendamento` (já
  existia) agora aceita array de serviços -- mesmo comportamento de
  sempre, equipe confirma manualmente.

**Achado real #2 testando contra a Groq de verdade**: a ferramenta
`buscar_horarios_disponiveis` devolvia o horário como ISO UTC cru
(`"2026-09-14T12:00:00.000Z"`) pro resultado da tool-call, e a IA leu o
número da hora direto sem converter, dizendo pro cliente "hoje às 12h"
quando o horário real era 09:00 (Brasília) -- corrigido formatando o
horário já em texto local antes de devolver como resultado da
ferramenta. Sem esse teste ponta a ponta contra a Groq real (não só
contra a lógica determinística), esse bug não teria aparecido.

`tratarRespostaPropostaHorario` foi generalizada pra tratar um grupo
inteiro de serviços de uma vez (`resposta: todos|parcial|nenhum`),
mesmo padrão de segurança já testado (retry×2, nunca assume nada se a
Groq falhar). Lógica de confirmação (recheca conflito + cria
`agendamentos` + marca confirmado) extraída pra
`src/lib/agendamento-confirmacao.js`, reusada em 4 lugares (rota
`/aceitar`, nova rota em lote `/grupo/:grupoId/aceitar`, e os dois
caminhos aberto/fechado dentro do webhook).

**Testado de verdade** (webhook local + Groq real, não só a lógica
determinística): pedido de 2 serviços com salão aberto → IA perguntou
preferência de profissional → buscou horário real → cliente aceitou →
2 `agendamentos` criados de verdade, sequenciais, sem conflito, sem
equipe nenhuma envolvida. Pedido de 2 serviços com salão fechado →
2 linhas de `solicitacoes_agendamento` criadas com o mesmo `grupo_id`,
equipe avisada que vai confirmar. Painel (`salon-v6.html`) testado no
navegador: os 2 serviços do mesmo pedido aparecem agrupados num card só.
Dado de teste limpo depois (agendamentos/solicitações/mensagens da conta
QA removidos).

**Não testado ainda**: caso de conflito real (dois clientes pedindo o
mesmo profissional/horário ao mesmo tempo) e caso de recusa parcial
(cliente aceita só 1 dos N serviços propostos) -- lógica existe e foi
revisada, mas não exercitada ponta a ponta contra a Groq real.

**`/code-review high` rodado depois da implementação** encontrou e
foram corrigidos 6 problemas reais: (1) "Aceitar tudo" no fluxo fechado
agendava todos os serviços no mesmo instante em vez de em sequência
(cliente pediu "sábado às 10h" pros 3 -- corrigido encadeando os
horários no momento do aceite em lote); (2) XSS armazenado em
`renderModalLotes` (número de lote sem escape em innerHTML -- mesma
classe de bug já corrigida no painel-admin, adicionado `escHtml`
global em `salon-v6.html`); (3) primeiro lote cadastrado descartava em
silêncio o estoque legado editado antes de existir lote (corrigido
criando um lote implícito representando o estoque antigo); (4)
preferência de profissional sendo substituída em silêncio quando a
preferida estava ocupada no primeiro horário candidato (corrigido pra
nunca substituir -- ou acha horário com a profissional pedida, ou
devolve vazio); (5) botão "Aceitar" no painel não aparecia pra
solicitação de busca automática revertida pra pendente (só checava
`data_hora_solicitada`, não `data_hora_proposta`); (6) resposta
"parcial" sem nenhum serviço listado (Groq incerta) tratava como
recusa total em vez de cair no fallback seguro de sempre.

**`/code-review ultra` (multi-agente, na nuvem) rodado em seguida**
encontrou mais 9 problemas reais no diff acumulado do dia (lotes +
painel-admin + agendamento self-service), todos corrigidos:
1. `buscarHorariosDisponiveis` não comparava o candidato com o horário
   atual -- podia propor (e no caminho salão-aberto até auto-confirmar)
   um horário já passado no dia de hoje. Corrigido pulando qualquer
   candidato `< Date.now()`. Testado de verdade: pedido às 23h54
   pulou corretamente pro dia seguinte.
2. XSS armazenado esquecido no bloco de solicitações agrupadas
   (`nomeCliente`/`pedido_cliente`, texto livre do cliente via
   WhatsApp, sem `escHtml`) -- mesma classe já corrigida em
   `renderModalLotes` no mesmo dia, ficou de fora aqui.
3. `resolverServico` casava `nome_servico` vazio/ausente com QUALQUER
   atividade (`''.includes()` é sempre `true`), resolvendo pro
   primeiro serviço do catálogo em vez de falhar -- bug pré-existente
   que a feature nova estendeu pro caminho que auto-confirma sem
   revisão humana. Corrigido: nome vazio não tenta match nenhum.
4. `propor-horario` não marcava `origem_proposta='equipe'` ao propor
   manualmente um horário pra um item nascido de busca automática --
   o item continuava sendo tratado como "não revisado por humano"
   mesmo depois da equipe vetar o horário à mão.
5. Update de encadeamento de horário no aceite em lote não checava
   erro -- falha silenciosa geraria agendamentos sobrepostos sem
   nenhum aviso.
6. `created_at` podia empatar entre linhas de um mesmo INSERT em lote
   (Postgres avalia `now()` uma vez por statement), quebrando a
   reconstrução da ordem pedida pelo cliente no aceite em grupo --
   corrigido escalonando `created_at` explicitamente por índice.
7. `.map()` de ids de profissionais recriado a cada iteração do
   horário candidato -- hoisted pra fora do loop.
8. Aceitação parcial com um item vazio em `servicos_aceitos` também
   casava com qualquer solicitação pendente (mesma classe do bug #3)
   -- corrigido filtrando nomes vazios antes de guardar o resultado.
9. Aceitar um grupo de N serviços mandava N mensagens de WhatsApp
   separadas pro cliente -- consolidado numa única mensagem
   (`notificarConfirmacaoGrupo`), mesmo espírito do que
   `tratarRespostaPropostaHorario` já fazia no caminho conversacional.

### Pagamento antecipado (Pix + gateways), suporte, auditoria e hub OmniFlow (15/09/2026)

Construído e deployado em produção: chave Pix solta (WhatsApp manda
copia-e-cola sem gateway, `src/lib/pix.js`), gateway de verdade com baixa
automática de comanda via webhook (`src/lib/gateways/{mercadopago,asaas,
efi}.js`, credenciais cifradas por estabelecimento, `POST /comandas/:id/
cobrar-pix` + `POST /webhooks/pix/:gateway/:estabelecimentoId`), central
de tickets dono↔admin (`src/routes/tickets.js` + `/admin/tickets`), log
de auditoria de acesso a dado sensível de cliente/LGPD (`src/lib/
auditoria.js`, instrumentado em clientes/agenda/whatsapp-conexao/
whatsapp), e `GET /admin/hub-metricas` (segredo compartilhado, não login)
pro painel interno da agência OmniFlow Studio acompanhar contas/MRR.
Isso resolve os itens 2, 7 e 8 da lista de pendências abaixo — mantidos
ali só como histórico, não estão mais em aberto.

Pendente ainda: testar os 3 gateways de ponta a ponta em sandbox
(nenhum foi testado com dinheiro/API real do provedor ainda).

### Cadastro só por convite + aprovação/plano pelo admin (16/09/2026)

Achado testando o cadastro de ponta a ponta: `cadastro-real.html` tinha
uma aba "Criar conta" aberta pra qualquer visitante (`signUp()` direto
com a anon key) -- vulnerabilidade real, qualquer pessoa virava dono de
salão sozinha. Substituído por convite:

- `POST /admin/convites` (admin.js) — David manda o link de acesso via
  `supabaseAdmin.auth.admin.inviteUserByEmail()` (mecanismo nativo do
  Supabase Auth, não um sistema de token construído do zero).
- `cadastro-real.html` — aba "Criar conta" removida, só sobrou login.
  Quem chega pelo link de convite (detectado pelo hash `type=invite` na
  URL, capturado ANTES de `createClient()` porque o supabase-js processa
  e pode limpar esse hash de forma assíncrona) vê uma tela "Defina sua
  senha" -- chama `updateUser({password})` + `PATCH /proprietarios/me`
  (rota nova, precisou de policy de UPDATE nova em `proprietarios`,
  migração 29 -- só existia policy de SELECT desde a migração 13).
- `painel-admin.html` — botão "+ Convidar salão" na página Contas;
  `verConta()` deixou de ser só leitura, ganhou `<select>` de
  status_assinatura/plano + `PATCH /admin/contas/:id` (David aprova
  depois do pagamento, deixa livre, ou troca o plano).

**⚠️ Pendência do David, fora do meu alcance**: desligar "Allow new
users to sign up" em Authentication → Providers → Email no Supabase
Dashboard. Sem isso, mesmo com a aba escondida, alguém ainda consegue
chamar `supabase.auth.signUp()` direto pelo console do navegador com a
anon key pública (que é pública de propósito, sempre foi) -- é a
Supabase, não o front, que precisa recusar cadastro não-convidado.

### Correções pós-teste real de cadastro + fim dos dados fake de Multi-Unidades (16/09/2026)

David testou o fluxo de convite/cadastro de ponta a ponta pelo celular e
notebook (conta `davidcoitinho231@gmail.com`) e foi achando problemas reais
no caminho, um de cada vez:

- **Convite redirecionando pra localhost / `ERR_CONNECTION_REFUSED`** —
  não era `PUBLIC_BASE_URL` (já estava certo no Railway). Causa real:
  Authentication → URL Configuration no Supabase Dashboard, **Site URL**
  e **Redirect URLs** ainda apontavam pro padrão (localhost) e sobrescrevem
  silenciosamente o `redirectTo` passado em `inviteUserByEmail()` se o
  domínio não estiver na allowlist. Corrigido pelo David no Dashboard.
- **Não dava pra reenviar convite pro mesmo e-mail** —
  `inviteUserByEmail()` recusa se o e-mail já existe em `auth.users`,
  mesmo não confirmado. Resolvido com um script pontual (service key)
  que apagou a linha de `proprietarios` (FK bloqueava `deleteUser`
  direto) e depois o usuário órfão em `auth.users` -- não ficou nada
  permanente no código, foi limpeza pontual de um teste travado.
- **Botão "Ir para o painel" só dava `alert()`** em vez de navegar --
  fix de uma linha em `cadastro-real.html` (era sobra de um placeholder).
- **Dias de funcionamento não tinham UI nenhuma** -- o backend/coluna
  `dias_funcionamento` já existia e era usado, mas ninguém nunca
  construiu o seletor. Adicionado em `salon-v6.html` → Configurações:
  toggles de dia da semana, salvos junto com o resto de
  `salvarConfigSalao()`.
- **"Gestão Multi-Unidades/Franquias" mostrando número inventado** --
  David perguntou "o que são esses números?" ao ver "Studio Moema",
  "Studio ABC", "R$ 39.940 de faturamento", "9 profissionais" -- tudo
  hardcoded num modal (`D.units`, array mockado no topo do arquivo).
  Substituído por um modal real a partir de `todosEstabelecimentos`
  (lista de verdade vinda do login, antes só se usava `estabelecimentos[0]`
  e o resto era descartado). **Isso expôs um padrão maior**: existem
  ainda **8 modais com dado fake** no registro `M` de `salon-v6.html`
  (`despesa`, `fechamento`, `pagamento`, `nfe`, `estqin`, `vendap`,
  `novaFunc`, `googleReserve`, `qrportal`) -- a maioria só mostra
  `Toast.show()` de "sucesso" sem chamar API nenhuma. **Decisão do
  David: não mexer agora**, foco em testar pagamento de verdade
  primeiro; `nfe` especificamente não pode ser tocado porque ele está
  validando a necessidade com os donos de salão (ver item 3 das
  pendências). Ver pendência nova abaixo.
- **Automação "Reativar Clientes" marcada como "(configurável)" mas sem
  jeito de configurar** -- o backend já aceitava `configuracao.dias_inatividade`
  via `PATCH /automacoes/:id`, só faltava o botão/modal no frontend.
  Adicionado botão "Configurar" (só aparece nas automações com
  `configuravel:true`) + `abrirModalConfigurarAutomacao()`. Confirmado
  nessa checagem que as 8 automações da tela são todas reais (nenhuma é
  decorativa): confirmação 24h, lembrete 2h, reativação e aniversário
  rodam pelo motor de 15 em 15 min (`scheduler.js`, chamado de verdade
  em `server.js`); retorno por ciclo também, usando `ciclo_recompra_dias`
  configurado por serviço; upsell no agendamento e lista de espera são
  gatilhos inline em `agenda.js`; avaliação pós-atendimento dispara em
  `fechar_comanda` e já nasce ativa por padrão.
- **Estoque de produtos sem editar/excluir** -- editar já existia
  (`abrirModalEditarProduto`), faltava excluir. Adicionado
  `DELETE /produtos/:id` (mesmo padrão de fallback de `DELETE /atividades/:id`:
  tenta apagar de vez, se bater em FK de receita/lote desativa em vez de
  falhar) + botão "Excluir" no modal de edição.
- Confirmado (David perguntou): telefone do proprietário (cadastro
  pessoal) e WhatsApp do salão já são campos **corretamente separados**
  (`proprietarios.telefone` vs. `estabelecimentos.whatsapp`) -- nenhuma
  mudança precisou ser feita, só confirmação.

### Status "livre", bloqueio por inadimplência e dados de conta no admin (16/09/2026)

David perguntou o que significava o status "trial" no painel-admin e se
todas as funções ficavam liberadas nele -- a resposta expôs que
`status_assinatura`/`plano` eram só rótulo/relatório até aqui, nada no
backend travava nada de verdade. Três pedidos vieram disso:

- **Novo status `'livre'`** (migração 30) -- acesso total, mesmo nível
  do plano "escala", sem contar como receita. `PATCH /admin/contas/:id`
  força `plano='escala'` sempre que `status_assinatura` vira `'livre'`,
  mesmo que outro plano tenha sido enviado junto.
- **Bloqueio de acesso de verdade** -- novo middleware
  `verificarAssinatura` (`src/middleware/verificarAssinatura.js`),
  montado logo depois de `autenticar` em `server.js`. Bloqueia (402)
  quando **todos** os estabelecimentos do proprietário logado estão em
  `inadimplente`/`cancelado`; `trial`, `ativo` e `livre` sempre passam,
  e quem ainda não tem nenhum estabelecimento (onboarding recém-saído
  do convite) também passa. **Pula `/admin/*` de propósito**: a conta
  de teste do David é dona de um estabelecimento de teste E é admin --
  se o estabelecimento de teste ficasse inadimplente, ele não pode se
  trancar fora do próprio painel-admin.
- **`painel-admin.html` → Contas**: `verConta()` agora mostra endereço
  completo, CNPJ do salão e CPF do proprietário (antes só tinha
  cidade). Campo de busca novo (`buscaConta`) filtra por nome do salão,
  CPF ou CNPJ -- client-side, sem rota nova (a lista de contas já vem
  inteira do backend).

Verificado direto no banco (service key, revertido em seguida): a
migração 30 realmente aceita `'livre'` no `status_assinatura` da conta
de teste QA.

### Cadastro manual de cliente (16/09/2026)

Até aqui, cliente só entrava no sistema pela conversa de onboarding do
WhatsApp -- não existia nenhuma rota pra cadastro manual. Adicionado
`POST /estabelecimentos/:id/clientes` (`src/routes/clientes.js`) +
botão "+ Cadastrar cliente" na aba Clientes de `salon-v6.html`, pro
caso de cliente que chega no balcão sem ter mandado mensagem antes.
Entra direto com `estado_onboarding='completo'` (quem cadastrou já
confirmou nome/telefone na hora, não faz sentido reabrir o fluxo de
perguntas que a IA usa no WhatsApp). Telefone duplicado no mesmo
estabelecimento retorna 409 (constraint `unique(estabelecimento_id,
telefone)` já existia).

### Conta de teste

Existe um estabelecimento de teste ("Studio Teste QA") no Supabase de
produção, criado antes desta sessão pra QA manual no navegador, logado
com a mesma conta usada no cadastro real (`davidrocha.coitinho@gmail.com`).
Uma segunda conta de teste (`davidrocha.coitinho+salonosteste@gmail.com`,
criada via auto-cadastro antes dele ser removido) ficou abandonada,
e-mail nunca confirmado — não usar. Teste de ponta a ponta do fluxo de
convite deve ser feito criando conta nova através de um convite real.
Credenciais não ficam neste arquivo — perguntar ao usuário se precisar.

### Achados de sessão não documentada + limpeza + 3 pendências fechadas (17/09/2026)

Sessão começou com "onde paramos" e uma varredura do que ficou pendurado
sem documentar desde 16/09. Achados, na ordem:

- **`vencimento_em`/lembrete de assinatura**: existia um recurso inteiro
  pronto no working tree, não commitado e não documentado aqui --
  `database/31-vencimento-assinatura.sql` (campo `vencimento_em` +
  `vencimento_lembrete_enviado_dias` em `estabelecimentos`) e
  `src/lib/lembretesAssinatura.js` (scheduler de 6h que avisa o DONO do
  salão, por WhatsApp, quando a assinatura dele tá vencendo -- 7/3/1/0
  dias, com Pix copia-e-cola da própria mensalidade via
  `SALONOS_CHAVE_PIX`). Já estava corretamente ligado em `server.js`
  (`iniciarSchedulerVencimento()`) e no `painel-admin.html`/`salon-v6.html`
  (campo de data + banner de aviso pro dono). Revisado de ponta a ponta,
  nenhum bug encontrado -- só nunca tinha sido commitado nem
  documentado. Migração 31 **ainda não rodada em produção**.
- **`GET /admin/hub-metricas`**: commit `39252a2` (15/09) e `1b6df0e`
  também tocam nisso mas não tinham entrada própria aqui -- rota
  autenticada por `X-Hub-Key` (segredo compartilhado, não login) pro
  painel interno da agência OmniFlow Studio acompanhar contas/MRR.
  Documentado retroativamente na seção "Pagamento antecipado..." acima.
- **Achado sério, fora do escopo do que foi pedido nesta sessão**: as
  entradas do changelog acima que citam `tests/subcontas.test.js`,
  `tests/webhook_asaas.test.js`, `tests/seguranca.test.js`,
  `tests/financeiro.test.js` e `tests/integracoes.test.js` com contagens
  tipo "24/24"/"260/260" -- **nenhum desses arquivos existe no disco
  nem no histórico do git** (`git log --follow` neles não acha nada,
  não é `.gitignore`). Ou foram escritos numa sessão que nunca commitou
  antes de terminar, ou se perderam de outro jeito. As alegações de
  cobertura dessas sessões passadas **não são mais verificáveis** --
  só `tests/crypto.test.js`, `tests/server.test.js` (smoke 401) e o
  `tests/agendamento-conflito-parcial.test.js` novo desta sessão
  existem de verdade hoje. Vale reconstruir a cobertura perdida aos
  poucos, não é urgente, mas fica registrado pra não confiar cegamente
  nos números antigos deste arquivo.
- **`openM()`/`M`/`clientDetail()` + `const D` removidos** de
  `salon-v6.html` (~230 linhas) -- eram código 100% morto, não o "8
  modais com dado fake, decisão de não mexer" que o item 11 antigo
  descrevia. O único botão que ainda chamava esse bloco (`openM('agend')`)
  referenciava uma chave que nem existe mais no registro `M` -- e
  `clientDetail()` (ficha de cliente com alergia/fórmula/histórico
  100% inventados) também não tinha nenhum botão que a alcançasse. As
  versões reais já existiam em outro lugar: despesa/saída ->
  `POST /caixa`; fechar comanda/pagamento -> `POST /comandas/:id/fechar`
  + Pix; ficha de cliente -> `abrirClienteDetalhe()` (linha ~710, real).
  Confirmado com David antes de apagar. `novaFunc`, `googleReserve` e
  `qrportal` (cadastro de funcionária avulso, integração Google
  Reserve/Instagram, portal PWA da cliente) nunca tiveram versão real
  em lugar nenhum -- por decisão do David, ficam fora de escopo por
  enquanto, mesmo critério do `nfe`/Marketplace.
- **Venda avulsa de produto no balcão (real)**: `database/32-venda-avulsa-produto.sql`
  (`produtos.preco_venda`, função `vender_produto_avulso` -- dá baixa
  por FEFO via `dar_baixa_estoque_fefo` já existente e lança a entrada
  no caixa), rota `POST /produtos/:id/vender`. UI: campo "Preço de
  venda" no cadastro/edição de produto, botão "Vender" na linha do
  produto (só aparece se tiver preço de venda) e dentro do modal de
  edição. `npm test` 45/45 depois da mudança.
- **Reverificação de e-mail a cada logout/expiração de sessão (item 12
  antigo, agora resolvido)**: `sb.auth.onAuthStateChange` escuta
  `SIGNED_OUT` (cobre botão Sair E expiração real de sessão sem
  diferenciar, os dois batem nesse evento) e marca
  `localStorage['salonos_requer_reverificacao']='1'`. Próximo login com
  essa flag: depois da senha, dispara `signInWithOtp` (código de 6
  dígitos por e-mail, sem criar usuário novo) e só entra no painel
  depois de `verifyOtp` confirmar -- tela nova `#lwCodigo` em
  `salon-v6.html`. **Pendência do David, fora do meu alcance**: o
  e-mail de "Magic Link" do Supabase por padrão só manda um link
  clicável, não um código de 6 dígitos visível -- pra esse fluxo
  funcionar de verdade, ele precisa editar o template em
  Authentication → Email Templates → Magic Link no Supabase Dashboard
  pra incluir `{{ .Token }}` no corpo do e-mail (mesma categoria de
  ajuste manual que "Site URL"/"Allow new users to sign up" já
  precisaram antes). **Limite conhecido**: hoje é só um gate do lado do
  cliente (JS) -- a sessão da senha já é tecnicamente válida antes do
  código ser confirmado, então isso não é enforcement de servidor, só
  UX. Enforcement de verdade exigiria guardar um estado "reverificado
  nesta sessão" em `app_metadata` e checar isso em `autenticar()`
  (`src/middleware/auth.js`) -- não implementado, fora de escopo por
  ora.
- **Testado (item 9 antigo, "conflito de horário real/recusa parcial",
  agora coberto)**: `tests/agendamento-conflito-parcial.test.js`, novo.
  Sem bater em rede/Supabase/Groq de verdade (mesmo padrão dos outros
  testes, ver `jest.setup.js`) -- dublês reproduzindo exatamente a
  cadeia do client do Supabase e a forma da resposta da Groq. Cobre:
  `confirmarSolicitacaoAgendamento` recusando quando há conflito real de
  horário da profissional (e confirmando quando não há), e
  `tratarRespostaPropostaHorario` confirmando só o serviço aceito e
  devolvendo o outro pra `pendente` quando o cliente aceita parcial, e
  nunca assumindo "recusou tudo" quando a Groq devolve `parcial` sem
  nenhum serviço listado (ambíguo). Teste de conversa real via WhatsApp
  continua pendente (ver Ordem sugerida item 2) -- não reativado aqui
  de propósito, dado o histórico de incidente com número pessoal.

## Pendências reais restantes

1. **Evolution API/Railway — RESOLVIDO em 13-14/09**: plano do Railway
   ativado (workspace `davidrocha.coitinho@gmail.com`), `salonos-api` e
   Evolution API deployados de verdade e online (ver seção "Deploy em
   produção" acima). Testado com WhatsApp real: conexão por QR pareou de
   verdade, importação de contatos funcionou (depois do fix do bug
   `remoteJid`). O motor de automações/gatilho de avaliação já pode
   enviar mensagem de verdade a partir de agora (antes só logava).
2. **Pagamento antecipado / sinal — RESOLVIDO em 15/09**: chave Pix
   solta + 3 gateways (Mercado Pago/Asaas/Efí) com baixa automática de
   comanda. Ver seção "Pagamento antecipado (Pix + gateways)..." acima.
   Falta só testar os gateways em sandbox de verdade.
3. **Nota fiscal (NFS-e)** — "tem cliente que pede nota" (14/09), ainda
   **não escopado nem construído**. Área regulada (emissão de NFS-e
   depende de integração com prefeitura/provedor tipo NFE.io, eNotas,
   Focus NFe, e dado fiscal de cada salão -- CNPJ, regime tributário).
   Duas linhas possíveis já discutidas: (a) simples -- só marcar "cliente
   pediu nota" na comanda, emissão de verdade continua manual, fora do
   sistema, zero custo/dependência; (b) completo -- emitir de verdade
   pelo sistema via provedor pago, com responsabilidade fiscal real.
   **Decisão (14/09): fica "em breve" por enquanto**, mesmo motivo do
   item 2 -- validar com os donos antes de escopar.
4. **Marketplace de Clientes** — placeholder "em breve", decisão consciente
   (13/09): diretório público + rastreio de origem é decisão de canal de
   aquisição, não prioridade agora. Reavaliar quando fizer sentido.
5. **Rastreabilidade de lote de insumo — RESOLVIDO em 14/09**: migração
   22 rodada, testado no navegador de verdade (2 lotes com validades
   diferentes, fechamento de comanda confirmando baixa FEFO pelo lote
   mais próximo do vencimento). Ver seção "Rastreabilidade de lote
   (FEFO) + painel-admin.html real" acima.
6. **`painel-admin.html` — RESOLVIDO em 14/09**: migração 23 rodada,
   admin inserido, login testado no navegador com dado real de
   Contas/Visão Geral. Financeiro/Suporte/Auditoria ficam "em breve"
   por decisão explícita (ver seção acima).
7. **Log de auditoria real (LGPD) — RESOLVIDO em 15/09**: ver seção
   "Pagamento antecipado (Pix + gateways)..." acima.
8. **Central de suporte (tickets) — RESOLVIDO em 15/09**: ver mesma
   seção acima.
9. **Agendamento self-service com múltiplos serviços — RESOLVIDO em
   14/09, teste de conversa real de ponta a ponta em 18/09**: ver seção
   "Sessão de 18/09..." acima pra lista completa de bugs achados e
   corrigidos nesse teste real (fora do horário virou igual ao aberto,
   `propor-horario` mandando pra instância errada, mensagens cortadas
   por `max_tokens`, saudação repetida, etc.). Fluxo aberto e fechado
   já não se distinguem mais (mesma lógica pros dois, só muda o aviso
   de "estamos fechados" no tom).
10. **Desligar "Allow new users to sign up" no Supabase Dashboard —
    RESOLVIDO em 16/09**: David confirmou que já desligou.
11. **8 "modais com dado fake" -- eram código morto, removido em
    17/09**: não eram funcionalidades ativas usando dado fake, era
    `openM()`/`M`/`clientDetail()` (+ o mock `D`) inalcançável por
    nenhum botão da UI atual -- ver seção "Achados de sessão não
    documentada..." acima pro detalhe. `despesa`/`fechamento`/`pagamento`
    já têm versão real em outro lugar do app; `nfe` continua de fora
    por decisão de produto (mesmo motivo do item 3); `estqin`/`vendap`
    (entrada e venda avulsa de produto) ganharam versão real em 17/09
    (`vender_produto_avulso`, migração 32); `novaFunc`/`googleReserve`/
    `qrportal` seguem fora de escopo, decisão consciente do David.
12. **Reverificação de e-mail a cada login/expiração de sessão --
    RESOLVIDO em 17/09** (ver seção "Achados de sessão não
    documentada..." acima): `signInWithOtp`/`verifyOtp` nativos do
    Supabase, disparado sempre que `SIGNED_OUT` acontece (logout ou
    sessão expirada, sem diferenciar). **Pendência do David**: editar o
    template de e-mail "Magic Link" no Supabase Dashboard pra incluir
    `{{ .Token }}` (hoje só manda link clicável, sem código visível) --
    sem isso o código nunca chega pro dono ver. Enforcement é só do
    lado do cliente por ora, não do servidor (ver seção acima pro
    porquê).
13. **Migração 31 (vencimento de assinatura) — RESOLVIDO em 17/09**:
    rodada em produção pelo David. Lembrete testado direto contra
    `verificarVencimentos()` usando o estabelecimento QA (`whatsapp_status:
    desconectado`, então sem risco de mandar mensagem real): limiares
    7/3/1/0 dias marcam `vencimento_lembrete_enviado_dias` corretamente,
    dedupe não reenvia no mesmo limiar, dia fora do limiar (ex. 5) não
    marca nada. Também corrigido de brinde: `iniciarScheduler()` e
    `iniciarSchedulerVencimento()` (`src/lib/automacoes/scheduler.js`,
    `src/lib/lembretesAssinatura.js`) só tinham `setInterval`, sem rodar
    uma vez ao subir -- todo restart (deploy, crash) abria uma janela
    morta de até 15min (automações de cliente) / 6h (vencimento) sem
    nenhuma checagem. Não perdia dado (checagem é sempre por data no
    banco), só atrasava o próximo aviso. Agora chama a função uma vez
    antes de armar o `setInterval`. `npm test` 45/45 depois da mudança.

    **Teste de envio real em produção (17/09)**: conectado de verdade o
    WhatsApp do estabelecimento "Harry Studio" (QR escaneado, número
    real do David) e disparado o lembrete de vencimento contra produção
    via `railway run` (env vars reais, sem tocar em `.env` local).
    **Bug real achado na primeira tentativa**: Evolution API recusou o
    envio (`{"exists":false}`) porque `proprietarios.telefone` estava
    salvo sem DDI (`11977435644`), diferente de
    `estabelecimentos.whatsapp_numero` (vem do pareamento, já com DDI:
    `5511977435644`). **Corrigido**: `normalizarTelefone()` nova em
    `src/lib/evolution-api.js`, aplicada dentro de `enviarTexto` (ponto
    único de envio) -- detecta pelo tamanho do número (10/11 dígitos =
    sem DDI, precisa de `55` na frente), não pelo prefixo, porque DDD 55
    (Rio Grande do Sul) existe de verdade e um prefixo `"55"` já
    presente pode ser DDD local, não DDI. Retestado depois do fix:
    mensagem chegou de verdade no WhatsApp real, confirmado pelo David.
    Esse bug afetava **qualquer** envio (lembrete de vencimento,
    automações pro cliente, resposta da IA) pra um telefone cadastrado
    sem DDI, não só esse caso -- corrigido pra todos de uma vez por
    estar no choke point. Instância de teste do Harry Studio desconectada
    depois do teste (mesmo cuidado do incidente de 13/09).
14. **`pareceNome()` não pegava frase completa que não é nome --
    RESOLVIDO em 18/09**: `extrairNomeOuNull()` nova (`src/routes/whatsapp.js`)
    substitui `extrairCampoComIA` na etapa de nome do onboarding -- pede
    pra própria IA julgar se a mensagem contém um nome de pessoa de
    verdade (não só filtrar por ter letra), extraindo o nome mesmo de
    dentro de uma frase ("meu nome é Andrea" -> "Andrea") e já
    devolvendo capitalizado. `pareceNome()` continua como segunda
    camada (defesa em profundidade). Testado ao vivo contra a Groq real
    com bateria de casos -- 2 bugs a mais achados e corrigidos no
    caminho:
    - Nome em minúscula sendo rejeitado ("joão"/"ana"/"pedro" ->
      `NAO_E_NOME`, mas "João"/"Ana"/"Pedro" passavam) -- no WhatsApp
      quase ninguém usa maiúscula, seria um falso-positivo grave
      (rejeitar nome válido de verdade). Prompt agora pede
      explicitamente pra capitalizar e avisa que minúscula é normal.
    - O sentinela `NAO_E_NOME` saía cortado (`"NAO_E_N"`) pelo mesmo
      motivo do bug de `max_tokens` documentado acima -- uma comparação
      `===` exata deixaria passar o sentinela truncado como se fosse um
      nome de verdade. `max_tokens` subiu de 60 pra 200 e a checagem
      virou `startsWith` em vez de igualdade exata.

    Commit `de9a202`, publicado em produção (deployment `65f08e6c`).

## Sessão de 18/09 — teste de conversa real ponta a ponta, vários bugs achados e corrigidos

Sessão longa testando o motor de agendamento via WhatsApp com conversa
real de verdade pela primeira vez (item 2 da "Ordem sugerida" abaixo,
finalmente destravado). WhatsApp do Harry Studio conectado de novo,
clientes reais (Andrea, Erika Fernandes) testando o fluxo completo.
Achados, na ordem que apareceram:

- **Agendamento sem revisão de data no passado**: `POST
  /estabelecimentos/:id/agendamentos`, `PATCH /agendamentos/:id` e
  `POST /solicitacoes-agendamento/:id/propor-horario` aceitavam
  qualquer data, inclusive no passado, sem avisar nada. `estaNoPassado()`
  nova em `src/lib/disponibilidade.js`, aplicada nos 3 pontos onde um
  humano digita data/hora à mão -- a busca automática
  (`buscarHorariosDisponiveis`) já se protegia sozinha.

- **Agendamento fora do horário virou igual ao horário aberto**: antes,
  cliente pedindo horário com o salão fechado sempre caía pra
  `registrar_solicitacao_agendamento` (revisão manual da equipe), mesmo
  quando o horário pedido estava livre. Agora `buscar_horarios_disponiveis`
  é tentada sempre (aberto ou fechado -- ela já respeita os dias/horários
  reais de funcionamento), só cai pra revisão manual se não achar vaga
  ou o cliente insistir num horário específico ocupado. Uma trava mais
  funda também travava isso: o código só confirmava um horário de busca
  automática aceito pelo cliente se o salão estivesse aberto *no exato
  momento da resposta* -- removida (`confirmarSolicitacaoAgendamento` já
  recheca conflito de verdade antes de criar, a trava era redundante).

- **Endereço/aniversário**: onboarding passou a pedir endereço completo
  (rua, número, bairro) explicitamente. `data_nascimento` virou
  aniversário só (dia e mês, nunca ano) em toda a superfície --
  `formatarAniversario()` nova valida MM-DD/DD-MM e usa ano-placeholder
  fixo (2000); `verificarAniversario()` já só comparava mês/dia, sem
  migração necessária.

- **Onboarding gerado pela IA**: as 3 mensagens do cadastro (saudação,
  pedir endereço, confirmar) viraram texto gerado pela Groq a cada
  conversa (`gerarMensagemOnboarding`) em vez de string fixa repetida
  igual pra todo cliente -- a ordem/estado continua determinística, cai
  pro texto fixo só se a IA falhar.

- **Nome inválido no onboarding**: cliente respondendo só "?", "," etc.
  quando a IA pergunta o nome virava literalmente o nome cadastrado.
  `pareceNome()` nova exige pelo menos 2 letras de verdade -- se não
  bater, não avança o estado, pergunta de novo. **Limite conhecido**:
  não pega frase completa que não é nome (achado de verdade nessa
  sessão: um cliente respondeu "só manda pro cara aqui" e isso *passou*
  na checagem, virou o nome -- pareceNome só filtra lixo sem letra
  nenhuma, não julga se parece um nome plausível). Ainda não corrigido,
  ver Pendências.

- **Bug real: `propor-horario` mandava pra instância WhatsApp errada**:
  a rota usava `req.params.id` (o ID da própria solicitação) como
  `estabelecimentoId` no lugar de `solicitacao.estabelecimento_id` --
  Evolution API recusava com 404 ("instância não existe"), falha
  silenciosa (só logava no servidor). Uma cliente real (Erika) ficou
  esperando uma proposta que nunca chegou. Corrigido, reenviada
  manualmente pra ela depois do fix.

- **Bug real: mensagens da IA cortadas/vazias por `max_tokens` baixo**:
  `gerarMensagemPropostaHorario` chegou a devolver texto vazio
  (`resposta.choices[0].message.content` sem fallback pro texto fixo
  quando a Groq responde OK mas com conteúdo vazio -- só o `catch` de
  erro lançado tinha fallback) e depois, já com o fallback certo, ainda
  cortou no meio ("Oi Erika, desculpe," e parou). Causa: `openai/gpt-oss-120b`
  é um modelo "reasoning", gasta parte do orçamento de tokens pensando
  antes de responder -- `max_tokens: 150`/`200`/`60` (várias chamadas
  curtas no arquivo) baixo demais pra sobrar espaço pra resposta de
  verdade. Todos os `max_tokens` de geração de texto curto subiram pra
  200-400, e todo `.content.trim()` sem `?.` virou protegido.

- **Proposta de horário "confirmava" sem esperar resposta do cliente**:
  achado testando ao vivo -- a mensagem gerada às vezes soava como
  confirmação em vez de pergunta (sem instrução negativa explícita
  proibindo isso), e no painel (`salon-v6.html`) o botão "Aceitar"
  continuava aparecendo mesmo com a solicitação em "aguardando
  resposta" -- clicar nele confirmava na hora sem o cliente ter dito
  nada. Corrigidos os dois: instrução negativa explícita na IA +
  `gerarMensagemPropostaHorario` agora recebe o horário/pedido original
  pra montar a desculpa certa; botão Aceitar só aparece quando nenhum
  item do grupo está em "aguardando resposta".

- **IA cumprimentava de novo no meio da conversa**: depois de uma
  correção de cadastro (nome/endereço/aniversário) via
  `atualizar_cadastro_cliente`, a próxima resposta às vezes começava
  com "Boa noite, [nome]!" de novo, como se a conversa tivesse
  recomeçado -- não é bug de rastreio de telefone (conferido: cada
  número tem cliente único no banco, sem duplicata), é a instrução de
  saudação no `montarSystemPrompt` sendo mal aplicada pela IA depois de
  um tool call. Corrigida: só cumprimenta se o histórico da conversa
  estiver vazio (primeira mensagem de verdade), nunca depois de
  qualquer coisa já ter acontecido na conversa.

- **Tom/markdown**: reforço de "sempre educada e cordial, mesmo com
  cliente direto/informal" e proibição explícita de markdown
  (`**negrito**`) nos 3 pontos que geram texto -- WhatsApp não
  renderiza, aparece com os asteriscos literais na tela (achado real:
  `**Corte Masculino**` apareceu assim pro cliente).

- **Agenda do painel só mostrava hoje**: agendamento de verdade criado
  pelo WhatsApp self-service (Andrea, confirmado no banco) não aparecia
  em lugar nenhum porque era pro dia seguinte e a tela nunca tinha
  jeito de navegar pra outro dia. Adicionado ◀/▶/"Hoje" no cabeçalho da
  agenda (`salon-v6.html`), `state.agendaData` persiste entre reloads.

- **"3 agendamentos" não era bug**: depois dos testes, o dia 18/09
  ficou com 3 agendamentos reais (Andrea + 2 da Erika testando busca
  automática duas vezes) -- não duplicação, só dado de teste acumulado.
  Os 2 da Erika foram cancelados manualmente depois (`status: cancelado`)
  pra deixar a agenda limpa com só o agendamento real.

Todos os fixes de código: `npm test` 45/45 a cada passo. Mudanças de
`salon-v6.html` são HTML/frontend, sem cobertura automatizada.
Commits, em ordem: `08e017b`, `01bd12f`, `b7c5703`, `38ef335`,
`ca87644`, `6e81fc1`, `c411da6`, `ab0c023`, `dbebfa7` -- todos com push
e `railway up`.

## Sessão de 21/09 — no-show automático, gênero/tema claro-escuro, limpeza de raiz

- **Arquivos soltos na raiz do repo** (`02-whatsapp-ia-servico.js`,
  `05-migracao-agendamentos.sql`, `06-migracao-no-show-automatico.sql`,
  2 `README-fase1*.md` duplicados, `analise-comparativa-mercado-2026.md`,
  3 `.zip`) -- apareceram sem ninguém lembrar a origem exata; confirmados
  como saída de uma sessão externa/isolada que nunca escreveu de fato
  nesse repo. Achado sério: `analise-comparativa-mercado-2026.md` alegava
  ter criado `src/routes/agendamentos.js` (**não existe**) e que
  `src/routes/profissionais.js` "estava faltando desde a migração 03"
  (na verdade já existia desde 10/09, antes dessa sessão externa). As duas
  migrações soltas (05/06) foram escritas contra um schema **diferente**
  do real (assumiam tabela `agendamentos` própria com `data_horario`/
  `valor_previsto`/`politica_pagamento_id`, status `'pendente'`/`'no_show'`
  -- a tabela real usa `inicio`/`fim`, status já inclui `'nao_compareceu'`
  desde a migração 05 de verdade). A 05 solta rodou e quebrou (`create
  table if not exists` é no-op contra a tabela já existente, então só o
  `create index` numa coluna inexistente tentou rodar e falhou); a 06
  solta "rodou sem erro" mas só criou uma função morta (Postgres não
  valida coluna referenciada dentro de um corpo `plpgsql` até a função ser
  chamada -- `politicas_pagamento` nunca existiu). Todos os 9 arquivos
  apagados depois de confirmar com o David.
- **Migração 33 -- marcação automática de no-show**
  (`database/33-no-show-automatico.sql`, substitui a função morta da 06
  solta via `create or replace function marcar_agendamentos_no_show`, mesma
  assinatura): fecha um gap real -- agendamento que passava do horário
  (`fim`) sem check-in ficava `agendado`/`confirmado` pra sempre, sem
  nenhum job que virasse `nao_compareceu` sozinho (a IA do WhatsApp já
  avisa cliente com histórico de falta que vai precisar de sinal,
  `LIMITE_FALTAS_SINAL`, mas "histórico de falta" só existia se alguém
  marcasse na mão). `taxa_no_show_pct` em `estabelecimentos` (mesmo padrão
  simples de `gateway_pagamento`, sem tabela de "políticas" separada) +
  `taxa_no_show` calculada (nunca cobrada sozinha) em `agendamentos` se o
  serviço tiver preço fixo (não `preco_variavel`). Novo scheduler
  `src/lib/marcarNoShow.js` (mesmo padrão dos outros dois: roda 1x no
  boot + `setInterval` de 1h), ligado em `server.js`. Migração rodada e
  verificada em produção (colunas confirmadas via query direta).
- **Gênero do proprietário + tema claro/escuro** (`database/34-genero-
  proprietario.sql`, pedido explícito do David): campo `genero`
  (`masculino`/`feminino`, nulo = trata como feminino, ninguém que já
  tinha conta muda de visual sozinho) em `proprietarios`. Masculino troca
  o tom de `cadastro-real.html`/`painel-proprietario.html`/`salon-v6.html`
  pra um visual mais escuro (mesmos tokens de cor de cada arquivo, valores
  trocados sob `html.tema-escuro` -- nenhum componente precisou ser
  reescrito; `--rose` vira um steel/grafite neutro em vez de outro rosa).
  Campo aparece na tela de convite (`cadastro-real.html`, com
  pré-visualização em tempo real) e, pra quem já tinha conta antes da
  migração, em `salon-v6.html` → Config → nova seção "Sua Conta" (salva
  junto do botão "Salvar configurações" já existente, aplica o tema na
  hora sem recarregar).
  **Bug achado testando no navegador**: a tela de login (`.lw`) é sempre
  escura por design (gradiente fixo `#1A1510`→`#2C1F1A`) e usa `var(--wh)`
  como branco fixo pro texto -- sem tratar isso, quem tem tema escuro
  ativo e desloga veria o texto de login ficar invisível (branco
  escurecido pelo tema, sobre fundo que já era escuro). Corrigido nos dois
  pontos de logout (`salon-v6.html`, `painel-proprietario.html`):
  removem a classe `tema-escuro` ao voltar pra tela de login.
- **Gotcha real de deploy**: os commits desse dia (`851c47a`, `90f1648`,
  `0fc425a`) ficaram só no repo local por um tempo -- David testou direto
  no Railway (produção) e "nada mudou" porque nunca tinha sido dado
  `git push`/`railway up`. Sempre confirmar se o código já foi enviado
  antes de investigar "por que não mudou nada" num ambiente publicado.
- **Gotcha do Railway CLI, atualizado**: `railway login --browserless`
  falhou **5 vezes seguidas** nesta sessão, sempre caindo em
  `davidrocha.analista@gmail.com` mesmo em aba anônima -- não é só cache
  de navegador como a nota antiga (item "Deploy em produção" acima)
  sugeria; o código de ativação por chat também expira rápido demais
  (menos de ~1min) pra esse relay funcionar. **O que funcionou**: pedir
  pro David rodar `railway login` (sem `--browserless`) **direto no
  terminal dele** via `!<comando>` no prompt do Claude Code -- abre o
  navegador local, ele troca de conta com calma lá, sem prazo curto nem
  relay. Preferir esse caminho primeiro da próxima vez. Depois do login
  certo, projeto precisou de `railway link -p salonos-api` de novo
  (logout/login limpa o link local) e `railway up -c --service
  salonos-api` (múltiplos serviços no projeto -- Evolution API/Postgres/
  Redis/salonos-api -- `--service` é obrigatório ou o comando falha
  pedindo pra escolher).

## Sessão de 22-24/09 — login separado por salão, "esqueci senha", correções de tema escuro

David pediu explicitamente: o login do proprietário (`painel-proprietario.html`,
margem/MRR de toda a rede) e o login do salão (`salon-v6.html`, operação do
dia a dia) eram a mesma conta até aqui -- qualquer funcionário que operasse
a agenda com a senha do dono também via o painel de rede inteiro. Motivo
dado pelo David: "um login pra as duas tela fica vulnerável, o funcionário
pode acessar o painel proprietario".

- **Migração 35** (`database/35-login-salao.sql`): `estabelecimentos.login_user_id`
  novo; `usuario_e_proprietario()` estendida (create or replace, cobre as
  ~11 migrações que já dependem dela sem precisar tocar em cada uma) --
  login do salão só enxerga a própria unidade (select/update, nunca
  delete/insert); proprietário continua com acesso total via
  `proprietario_id`, sem mudança pra quem já tinha conta. Confirmado com o
  David: "o login do proprietário continua funcionando exatamente como
  hoje em todas as unidades dele" -- desenho é aditivo, um segundo caminho
  de acesso, nunca substitui o primeiro.
- **`POST /estabelecimentos`** (tela 2 do cadastro) agora exige
  `email_salao`/`senha_salao`, cria o login via `supabaseAdmin.auth.admin.createUser`
  (novo `src/lib/supabaseAdmin.js`, singleton reaproveitado por
  `exigirAdmin.js` também), com rollback (`deleteUser`) se o insert do
  estabelecimento falhar depois. Catálogo do segmento pré-cadastrado
  automático no mesmo request (`adotarCatalogoCompleto`, extraída de
  `atividades.js` e reusada pelo atalho manual que já existia) -- decisão
  do David: sem tela de revisão no meio do cadastro.
- **`cadastro-real.html` reestruturado**: tela 1 (proprietário) ganhou CPF
  e e-mail somente leitura; tela 2 (estabelecimento) ganhou CNPJ e a seção
  de login do salão, perdeu cidade/bairro/CEP (viraram campos novos em
  `salon-v6.html` → Config → Informações do Salão) e perdeu a tela de
  seleção manual de catálogo inteira (código morto removido:
  `renderCatalogo`/`alternarAtividadeCatalogo`/`confirmarServicosSelecionados`/`pularCatalogo`).
- **`painel-proprietario.html` bloqueia de verdade** um login de salão
  agora -- antes, se `GET /proprietarios/me` falhasse (sem linha em
  `proprietarios`, exatamente o caso de um login de salão), o código só
  caía num fallback silencioso (`nm: '—'`) e continuava mostrando a casca
  do painel de rede mesmo assim.
- **Dois bugs reais achados testando local antes de subir** (por isso
  existe a migração 36, e por isso vale sempre testar local primeiro
  quando mexe em auth/RLS):
  1. `criar_proprietario_no_signup()` dispara pra **qualquer** usuário
     novo em `auth.users`, não só convite de proprietário -- o login do
     salão criado em `POST /estabelecimentos` ganhava uma linha em
     `proprietarios` sem querer, furando o bloqueio acima por completo
     (o login do salão "parecia" um proprietário válido). Migração 36
     (`database/36-login-salao-sem-proprietario.sql`) marca o login do
     salão com `user_metadata: {tipo:'login_salao'}` na criação e faz o
     gatilho pular esse caso.
  2. Mesmo depois do fix acima, achado um segundo bug testando na mesma
     aba: quando `carregarDados()` barra o login (lança erro), a casca do
     painel (`#mainWrap`/`#topbar`/`#heroSection`) só ficava escondida se
     já estivesse escondida antes -- se a aba já tinha mostrado um painel
     válido momentos antes (ex: testando dois logins em sequência sem dar
     F5), o painel antigo continuava visível por trás do erro. Corrigido
     escondendo a casca também no `catch` de `doLogin()`, mesmo tratamento
     que o botão Sair já tinha.
- **"Esqueci minha senha"** nos dois painéis (`resetPasswordForEmail` +
  tela de nova senha via hash `type=recovery`, mesmo padrão de captura de
  hash antes do `createClient()` já usado pro convite). Duas decisões
  explícitas do David: (1) mensagem sempre genérica, nunca diferencia
  "e-mail existe" de "e-mail não existe" -- diferenciar seria enumeração
  de conta, uma vulnerabilidade real; (2) depois de trocar a senha, força
  logout e exige login de novo (não aproveita a sessão da recuperação
  pra entrar direto).
- **Testado localmente de ponta a ponta com convite real** (sem tocar em
  Harry Studio/produção): gerado convite via `supabaseAdmin.auth.admin.generateLink`
  (sem precisar de e-mail de verdade, action_link capturado e o hash
  reaplicado direto numa URL `localhost`, já que o Supabase ignora
  `redirectTo` fora da allowlist de Redirect URLs configurada -- mesmo
  gotcha documentado em 16/09). Confirmado: cadastro completo, 8 serviços
  pré-cadastrados, login do salão isolado à própria unidade (só vê 1
  estabelecimento via `GET /estabelecimentos`), login do salão bloqueado
  no painel de rede (depois dos 2 fixes acima), login do proprietário
  seguindo normal. Dados de teste sempre limpos depois (proprietário +
  estabelecimento + os dois `auth.users`).
- **Fora de escopo, decisão explícita do David**: contas já existentes
  (Harry Studio, Studio Teste QA) não ganham botão de "criar login do
  salão" agora -- só cadastro novo por enquanto.

**Também nesta sessão**, achado testando em produção de verdade (print
real do David): `.btp`/`.btg` (usados em quase todo botão de ação
principal -- Salvar configurações, Cadastrar cliente, Abrir comanda,
Conectar WhatsApp, Adicionar serviço, Painel do Proprietário) tinham
fundo fixo (gradiente escuro ou dourado, independente do tema) mas texto
em `var(--wh)`, que no tema escuro (migração 34, sessão anterior) vira
quase preto -- botão ficava com o texto invisível. Mesma classe de bug
corrigida no card "Seu salão hoje", no badge "NEW" da navbar, no selo
"Mais popular" da aba Planos, e nas telas de login dos dois painéis
(`.lh`/`.lbrand`/`.lf input`/`.lbtn`) -- qualquer combinação de "fundo
fixo entre temas + texto que depende de um token que muda de tema" é essa
mesma classe de bug; vale conferir de novo se aparecer mais alguma tela
com texto sumindo no tema escuro.

**Gotcha do Railway CLI**: `railway login --browserless` continuou
falhando (5x na sessão anterior, caindo sempre em
`davidrocha.analista@gmail.com`), mas depois de rodar `railway login`
(sem --browserless) direto no terminal do David uma vez, o CLI ficou
logado como `davidrocha.coitinho@gmail.com` e permaneceu assim pro resto
desta sessão (`railway whoami` confirmado antes de cada deploy) -- não
precisou repetir o processo.

### Cadastro rápido pelo admin + convites com link visível (24/09/2026)

Depois do login separado por salão (seção acima), David pediu duas coisas
a mais em cima do fluxo de convite:

- **`POST /admin/convites` agora devolve o link, não só "enviado"**: o
  motivo -- às vezes o cliente não tá com notebook/celular na hora, e o
  David quer preencher o cadastro por ele ali mesmo. `inviteUserByEmail`
  não devolve o link na resposta (só cria o usuário e manda o e-mail),
  então a rota gera um segundo link tipo `'recovery'` pro mesmo e-mail
  logo em seguida -- funciona porque o usuário já existe nesse ponto.
  `cadastro-real.html` (`VEIO_DE_CONVITE`) passou a tratar `type=recovery`
  igual a `type=invite` na tela "defina sua senha" só por causa disso.
- **Convites pendentes, persistente** (`GET /admin/convites-pendentes`):
  o link acima só aparecia uma vez no modal -- se o David saísse da tela,
  sumia. Nova lista na página Contas mostra todo proprietário com
  `nome=''` (convidado que nunca completou a tela 1) com um botão "Ver
  link" que re-gera um link novo a qualquer momento. `POST /admin/convites`
  também passou a tolerar "e-mail já convidado antes" em vez de falhar,
  já que re-clicar "Ver link" bate nesse mesmo endpoint de novo.
- **Cadastro rápido** (`POST /admin/cadastro-rapido`, botão "Cadastro
  rápido" ao lado de "+ Convidar salão"): cria proprietário +
  estabelecimento + login do salão numa tacada só, sem convite/e-mail/link
  nenhum -- pedido explícito do David, pra cadastrar cliente na hora,
  presencialmente. Mesmo modelo de dois logins de sempre (login do salão
  marcado `user_metadata:{tipo:'login_salao'}`, não vira proprietário --
  migração 36 continua valendo aqui), catálogo do segmento pré-cadastrado
  igual ao fluxo normal. Usa `req.supabaseAdmin` (não `req.supabase`)
  porque o proprietário novo não é o David logado -- RLS bloquearia pelo
  caminho comum. Rollback em cascata se qualquer passo falhar (apaga os
  `auth.users` já criados antes de devolver erro).

Testado localmente replicando a sequência exata das rotas direto contra
o Supabase (sem passar pelo Express -- as rotas exigem sessão de admin
de verdade, que não fica salva em lugar nenhum do repo): proprietário
criado com nome/telefone/gênero corretos vindo do `user_metadata`, CPF
setado à parte, login do salão confirmado SEM linha em `proprietarios`
(migração 36 segurando), catálogo pré-cadastrado. `npm test` 45/45.

## Ordem sugerida pra continuar

1. ~~Migrações 22 e 23~~ -- RESOLVIDO, testado no navegador (ver
   Pendências item 5/6). Migração 24 (grupo_id/origem_proposta) também
   já rodada, agendamento self-service testado ponta a ponta (item 9).
   Falta só testar conflito real/recusa parcial se quiser mais
   confiança antes de usar em produção com clientes de verdade.
2. ~~Testar o motor de agendamento via WhatsApp ponta a ponta com
   número real~~ -- RESOLVIDO em 18/09, ver seção "Sessão de 18/09..."
   acima. Achou e corrigiu vários bugs reais só visíveis numa conversa
   de verdade (não em teste com dublê).
3. ~~Corrigir o limite conhecido do `pareceNome()`~~ -- RESOLVIDO em
   18/09, ver Pendências item 14.
4. Validar com donos de salão se pagamento antecipado/sinal (Pendências
   item 2) e nota fiscal (Pendências item 3) são prioridade antes de
   escopar de verdade.
5. Login separado por salão (migrações 35/36) -- RESOLVIDO em 24/09 pra
   cadastro novo, testado ponta a ponta local com convite real. **Ainda
   não testado em produção com convite de verdade** (só local, e via
   chamada direta contra o Supabase pro cadastro rápido/convite com link
   -- nenhum dos dois foi clicado de ponta a ponta pelo navegador em
   produção ainda). Falta, se o David quiser: (a) confirmar em produção
   com um convite ou cadastro rápido real; (b) decidir se/quando
   adicionar retrofit pra Harry Studio e Studio Teste QA ganharem login
   de salão também (decisão explícita: fora de escopo por ora); (c)
   testar "esqueci minha senha" ponta a ponta com e-mail de verdade (só
   verificado estruturalmente nesta sessão -- bati rate limit de e-mail
   do Supabase testando reverificação de sessão, coisa não relacionada, e
   não cheguei a clicar um link de recuperação real).
