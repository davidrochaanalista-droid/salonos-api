# SalonOS API — Como esta peça se conecta com o resto

## O que existe agora

```
salonos-api/
├── package.json
├── .env.example
├── database/            ← migrações SQL (rodar em ordem no SQL Editor do Supabase)
├── docs/                ← blueprint de backend + estratégia de mercado
├── public/               ← painéis HTML (cadastro-real já fala com a API; os outros três ainda não)
├── tests/                ← jest + supertest
└── src/
    ├── server.js                    ← ponto de entrada (helmet, rate limit, log estruturado)
    ├── lib/crypto.js                ← criptografia de campo sensível (AES-256-GCM)
    ├── middleware/auth.js           ← valida token do Supabase Auth
    └── routes/
        ├── estabelecimentos.js      ← CRUD de estabelecimento
        ├── atividades.js            ← catálogo + atividades adotadas (+ segmentos ativos)
        ├── clientes.js              ← listagem, detalhe (com descriptografia) e edição de cliente
        ├── profissionais.js         ← CRUD de profissional + comissão padrão
        ├── agenda.js                ← agendamentos futuros
        ├── comandas.js              ← abertura, itens e fechamento (calcula margem real)
        ├── caixa.js                 ← lançamentos avulsos, extrato e resumo do dia
        ├── relatorios.js            ← margem real por unidade + ponderada da rede
        └── whatsapp.js              ← IA do WhatsApp, envio via Evolution API
```

## O fluxo de autenticação, de ponta a ponta

Este é o ponto mais importante para entender antes de ligar isso nos painéis HTML:

1. **O login acontece no navegador**, não neste backend. Cada painel HTML (painel-proprietario, salon-v6) vai precisar incluir o SDK `@supabase/supabase-js` e chamar `supabase.auth.signInWithPassword({ email, senha })` diretamente contra o Supabase — é assim que o login fake de hoje vira login real. `cadastro-real.html` já faz isso — use como referência.
2. Isso devolve um **token JWT**. O painel guarda esse token (em memória de página, ou em `sessionStorage` — nunca em `localStorage` de forma persistente sem cuidado extra).
3. Toda chamada do painel para esta API leva `Authorization: Bearer <token>` no cabeçalho.
4. O middleware `autenticar` (em `src/middleware/auth.js`) valida esse token e cria um **cliente Supabase escopado a ele** — não à `service_role key`. Isso é proposital: assim, o RLS que já está no schema entra em vigor sozinho. Se uma rota tiver um bug e esquecer de filtrar por `estabelecimento_id`, o Postgres barra mesmo assim, porque o token só enxerga o que pertence àquele usuário.

A única exceção é `routes/whatsapp.js` — ali não existe usuário logado (é a Evolution API chamando o webhook), então ele usa a `service_role key`, como já estava desde a primeira versão.

## Rotas disponíveis

| Método | Rota | O que faz |
|---|---|---|
| POST | `/estabelecimentos` | Cadastra um novo estabelecimento |
| GET | `/estabelecimentos` | Lista os estabelecimentos do proprietário logado |
| GET | `/estabelecimentos/:id` | Detalhe de um estabelecimento |
| PATCH | `/estabelecimentos/:id` | Edita dados do estabelecimento |
| GET | `/segmentos` | Lista os segmentos disponíveis para venda (saúde regulada fica de fora, ver Decisão 6) |
| GET | `/atividades-catalogo?segmento_id=` | Catálogo sugerido para um segmento |
| GET | `/estabelecimentos/:id/atividades` | Atividades já vinculadas ao estabelecimento |
| POST | `/estabelecimentos/:id/atividades` | Adota uma atividade do catálogo, ou cadastra uma customizada |
| POST | `/estabelecimentos/:id/atividades/adotar-catalogo-completo` | Atalho: adota tudo do catálogo do segmento de uma vez |
| PATCH | `/atividades/:id` | Edita preço/duração/status/**custo de insumo** de uma atividade |
| GET | `/estabelecimentos/:id/clientes` | Lista clientes do estabelecimento |
| GET | `/clientes/:id` | Detalhe do cliente (observações descriptografadas), memória da IA e último atendimento |
| PATCH | `/clientes/:id` | Edita cliente; `observacoes` é criptografado antes de gravar |
| POST | `/estabelecimentos/:id/profissionais` | Cadastra profissional |
| GET | `/estabelecimentos/:id/profissionais` | Lista profissionais |
| PATCH | `/profissionais/:id` | Edita nome/comissão padrão/status |
| POST | `/estabelecimentos/:id/agendamentos` | Cria agendamento futuro |
| GET | `/estabelecimentos/:id/agendamentos?desde=&ate=` | Lista agendamentos num intervalo |
| PATCH | `/agendamentos/:id` | Edita horário/status/profissional |
| POST | `/estabelecimentos/:id/comandas` | Abre uma comanda para um cliente |
| GET | `/estabelecimentos/:id/comandas?status=&desde=&ate=` | Lista comandas |
| GET | `/comandas/:id` | Detalhe da comanda com itens |
| POST | `/comandas/:id/itens` | Adiciona serviço à comanda (custo/comissão herdados do cadastro, sobrescrevíveis) |
| DELETE | `/comandas/:id/itens/:itemId` | Remove item antes de fechar |
| POST | `/comandas/:id/fechar` | Calcula margem real, grava caixa e histórico de atendimento (função `fechar_comanda`) |
| POST | `/estabelecimentos/:id/caixa` | Lançamento avulso (entrada/saída) |
| GET | `/estabelecimentos/:id/caixa?desde=&ate=` | Extrato do caixa |
| GET | `/estabelecimentos/:id/caixa/resumo` | Soma entradas/saídas do período (padrão: dia corrente) |
| GET | `/relatorios/margem-rede` | Margem real por estabelecimento do proprietário + total ponderado da rede |
| POST | `/webhook/whatsapp/:estabelecimentoId` | Recebe mensagem do WhatsApp via Evolution API (sem autenticação de usuário) |
| GET | `/health` | Checagem de saúde (Railway + painel-admin) |

## Tempo real (LISTEN/NOTIFY)

Todo insert em `caixa_entradas` (criado automaticamente ao fechar uma comanda, ou manual) dispara `pg_notify` no canal `caixa_<estabelecimento_id>`. Isso ainda não tem um listener no backend nem WebSocket exposto ao frontend — falta implementar o lado que assina esse canal (Postgres `LISTEN`, mesma técnica validada no GiroCerto, ~1,7s de latência) e repassa para o painel via WebSocket/SSE. Sem isso, o "ao vivo" dos painéis continua sendo `setInterval` fake.

## Segurança implementada

- Rate limiting: 300 req/15min geral, 60 req/min no webhook do WhatsApp
- `helmet` (headers de segurança padrão)
- Log estruturado (`pino`), com `Authorization`/`apikey` redigidos
- Campo sensível de cliente (`observacoes`) criptografado em AES-256-GCM antes de gravar (`CRYPTO_KEY`, 32 bytes hex)
- RLS em cascata no Postgres (função `usuario_e_proprietario`) — mesmo com bug na rota, o banco barra acesso cross-estabelecimento

**Pendente:** `qs` (dependência transitiva do Express 4) tem uma vulnerabilidade moderada sem correção não-breaking disponível — migrar para Express 5 resolveria, mas é mudança maior, não feita ainda.

## Como rodar localmente

```bash
cd salonos-api
npm install
cp .env.example .env    # preencher com suas chaves reais (Supabase, Groq, Evolution API, CRYPTO_KEY)
npm run dev
```

## Como rodar os testes

```bash
npm test
```

Os testes não batem em rede/Supabase real (`jest.setup.js` define env vars dummy) — cobrem roteamento, autenticação e a criptografia. CI roda isso a cada push/PR (`.github/workflows/ci.yml`).

## Deploy no Railway

Mesmo padrão já validado no GiroCerto e no Torre: conectar o repositório, definir as variáveis de ambiente do `.env.example` no painel do Railway, e o deploy sobe sozinho a partir do `package.json` (`npm start`).

## Rodando as migrações no Supabase

No SQL Editor do projeto Supabase, rodar **nesta ordem** (todas usam `if not exists`/`on conflict do nothing`, então é seguro rodar de novo se não tiver certeza do que já rodou):

1. `database/01-schema-fase1.sql`
2. `database/03-migracao-onboarding-historico.sql`
3. `database/04-catalogo-completo-segmentos.sql`
4. `database/05-agenda-comanda-caixa.sql`
5. `database/06-desativar-segmentos-saude-regulada.sql`

(`00-executar-tudo.sql` é um bundle histórico de antes da migração 03 existir separada — prefira rodar os arquivos numerados acima individualmente.)

## O que ainda falta para os painéis HTML conversarem com esta API

`cadastro-real.html` já faz isso (Supabase Auth real + `fetch()` para a API). Os outros três (`painel-admin.html`, `painel-proprietario.html`, `salon-v6.html`) ainda rodam 100% sobre `const D = {...}` mockado e uma função `doLogin()` fake — nenhum fala com o backend ainda. Portar cada um segue o mesmo padrão de `cadastro-real.html`:

1. Adicionar o SDK `@supabase/supabase-js` (CDN)
2. Trocar `doLogin()` fake por `supabase.auth.signInWithPassword`
3. Trocar `const D = {...}` por `fetch()` para as rotas desta API, com o token salvo no passo 2
4. `salon-v6.html` (agenda/comanda/caixa) só faz sentido portar depois de validar `painel-proprietario.html`/`painel-admin.html` — é a tela maior e mais arriscada de migrar

## O que ainda não está implementado (próximas fases)

- WebSocket/SSE que assina o `LISTEN` do Postgres e repassa pro painel em tempo real
- Rastreabilidade de lote de insumo (nicho de clínica de estética, ver `docs/SalonOS-estrategia-diferenciacao-2026.md`, Eixo 3)
- Painel de auditoria/LGPD do `painel-admin.html` a partir de `whatsapp_mensagens` real (hoje mockado)
- Confirmar que as migrações realmente rodaram no projeto Supabase de produção (ninguém validou isso ainda nesta sessão)
