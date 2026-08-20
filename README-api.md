# SalonOS API — Como esta peça se conecta com o resto

## O que existe agora

```
salonos-api/
├── package.json
├── .env.example
└── src/
    ├── server.js                    ← ponto de entrada
    ├── middleware/auth.js           ← valida token do Supabase Auth
    └── routes/
        ├── estabelecimentos.js      ← CRUD de estabelecimento
        ├── atividades.js            ← catálogo + atividades adotadas
        ├── clientes.js              ← listagem e detalhe de cliente
        └── whatsapp.js              ← o 02-whatsapp-ia-servico.js, sem alteração
```

## O fluxo de autenticação, de ponta a ponta

Este é o ponto mais importante para entender antes de ligar isso nos painéis HTML:

1. **O login acontece no navegador**, não neste backend. Cada painel HTML (painel-proprietario, salon-v6) vai precisar incluir o SDK `@supabase/supabase-js` e chamar `supabase.auth.signInWithPassword({ email, senha })` diretamente contra o Supabase — é assim que o login fake de hoje (`value="12345678"` que a gente já removeu) vira login real.
2. Isso devolve um **token JWT**. O painel guarda esse token (em memória de página, ou em `sessionStorage` — nunca em `localStorage` de forma persistente sem cuidado extra).
3. Toda chamada do painel para esta API leva `Authorization: Bearer <token>` no cabeçalho.
4. O middleware `autenticar` (em `src/middleware/auth.js`) valida esse token e cria um **cliente Supabase escopado a ele** — não à `service_role key`. Isso é proposital: assim, o RLS que já está no schema entra em vigor sozinho. Se uma rota tiver um bug e esquecer de filtrar por `estabelecimento_id`, o Postgres barra mesmo assim, porque o token só enxerga o que pertence àquele usuário.

A única exceção é `routes/whatsapp.js` — ali não existe usuário logado (é a Meta ou a Evolution API chamando o webhook), então ele usa a `service_role key`, como já estava desde a primeira versão.

## Rotas disponíveis nesta primeira leva

| Método | Rota | O que faz |
|---|---|---|
| POST | `/estabelecimentos` | Cadastra um novo estabelecimento |
| GET | `/estabelecimentos` | Lista os estabelecimentos do proprietário logado |
| GET | `/estabelecimentos/:id` | Detalhe de um estabelecimento |
| PATCH | `/estabelecimentos/:id` | Edita dados do estabelecimento |
| GET | `/segmentos` | Lista os 18 segmentos disponíveis |
| GET | `/atividades-catalogo?segmento_id=` | Catálogo sugerido para um segmento |
| GET | `/estabelecimentos/:id/atividades` | Atividades já vinculadas ao estabelecimento |
| POST | `/estabelecimentos/:id/atividades` | Adota uma atividade do catálogo, ou cadastra uma customizada |
| POST | `/estabelecimentos/:id/atividades/adotar-catalogo-completo` | Atalho: adota tudo do catálogo do segmento de uma vez (fluxo de cadastro inicial) |
| PATCH | `/atividades/:id` | Edita preço/duração/status de uma atividade |
| GET | `/estabelecimentos/:id/clientes` | Lista clientes do estabelecimento |
| GET | `/clientes/:id` | Detalhe do cliente, incluindo resumo de memória da IA e último atendimento |
| POST | `/webhook/whatsapp/:estabelecimentoId` | Recebe mensagem do WhatsApp (sem autenticação de usuário) |

Faltam propositalmente nesta leva: rotas de agenda/comanda/caixa (o `salon-v6.html` tem essas telas, mas ainda com dado mockado — é a próxima fase natural depois que cadastro + auth estiverem validados ponta a ponta).

## Como rodar localmente

```bash
cd salonos-api
npm install
cp .env.example .env    # preencher com suas chaves reais do Supabase e da Groq
npm run dev
```

## Deploy no Railway

Mesmo padrão já validado no GiroCerto e no Torre: conectar o repositório, definir as variáveis de ambiente do `.env.example` no painel do Railway, e o deploy sobe sozinho a partir do `package.json` (`npm start`).

## O que ainda falta para os painéis HTML conversarem com esta API

1. Adicionar o SDK `@supabase/supabase-js` nos três HTMLs (via CDN, mesmo padrão de import que já é usado no restante do projeto)
2. Trocar a função `doLogin()` fake (hoje só esconde a tela de login) por uma chamada real a `supabase.auth.signInWithPassword`
3. Trocar os dados mockados (`const D = {...}`) por `fetch()` para as rotas desta API, usando o token salvo no passo 2
4. Isso deveria ser feito primeiro no fluxo mais simples — cadastro de estabelecimento — antes de migrar agenda/comanda/caixa, para validar a ponte inteira com o menor risco

## O que ainda não está implementado nesta API (próximas fases)

- Rotas de agenda, comanda e caixa (dependem de decidir a tabela de agendamento, que ainda não existe no schema — só existe `atendimentos`, que registra o que já aconteceu, não o que está agendado para o futuro)
- Descriptografia do campo `clientes.observacoes_criptografadas` em camada de aplicação (a função já está especificada no `blueprint-backend-salonos.md`)
- Rota de cadastro de `profissionais` (a tabela existe desde a migração 03, mas ainda não tem endpoint)
- Populações do log de auditoria do `painel-admin.html` a partir de dados reais (hoje mockado)
