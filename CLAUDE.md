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

### Conta de teste

Existe um estabelecimento de teste ("Studio Teste QA") no Supabase de
produção, criado nesta sessão pra QA manual no navegador, logado com a
mesma conta usada no cadastro real (`davidrocha.coitinho@gmail.com`).
Credenciais não ficam neste arquivo — perguntar ao usuário se precisar.

## Pendências reais restantes

1. **Evolution API/Railway — RESOLVIDO em 13-14/09**: plano do Railway
   ativado (workspace `davidrocha.coitinho@gmail.com`), `salonos-api` e
   Evolution API deployados de verdade e online (ver seção "Deploy em
   produção" acima). Testado com WhatsApp real: conexão por QR pareou de
   verdade, importação de contatos funcionou (depois do fix do bug
   `remoteJid`). O motor de automações/gatilho de avaliação já pode
   enviar mensagem de verdade a partir de agora (antes só logava).
2. **Pagamento antecipado / sinal** — cliente perguntou "e se quiser pagar
   antecipado?" (14/09), ainda **não escopado nem construído**. Hoje só
   existe o aviso de que "vai precisar de sinal" pra cliente com histórico
   de falta (`LIMITE_FALTAS_SINAL`, ver seção acima) -- é só um aviso em
   texto, não cobra nada de verdade. Falta decidir: qual gateway (Pix
   direto, Mercado Pago, Asaas, Stripe?), como confirmar o pagamento
   (webhook do gateway?), o que acontece se o cliente não pagar a tempo.
   Também seria a base pra um "sinal obrigatório" de verdade (não só pra
   quem já faltou) se o dono quiser reduzir falta em geral -- ver
   recomendação dada ao usuário nesse dia.
3. **Marketplace de Clientes** — placeholder "em breve", decisão consciente
   (13/09): diretório público + rastreio de origem é decisão de canal de
   aquisição, não prioridade agora. Reavaliar quando fizer sentido.
4. **Rastreabilidade de lote de insumo** (Eixo 3, clínica de estética
   pequena) — não implementado, não escopado ainda.
5. **`painel-admin.html`** — continua fora de escopo (console interno da
   SalonOS, não do salão).

## Ordem sugerida pra continuar

1. Testar o motor de agendamento via WhatsApp ponta a ponta com número
   real com calma (conexão já validada, mas registrar_solicitacao_agendamento,
   aceitar/propor horário, checagem de conflito, lembrete 2h e aviso de
   sinal ainda não passaram por um teste de conversa real -- ver avisos
   de "não testado dentro do webhook real" nas seções acima)
2. Escopar pagamento antecipado/sinal (item 2 acima) se o dono quiser
   seguir essa linha pra reduzir falta
3. Escopar rastreabilidade de lote de insumo (Eixo 3)
