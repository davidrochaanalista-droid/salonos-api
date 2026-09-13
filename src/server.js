/**
 * SalonOS API — Servidor principal
 * ==================================
 * Estrutura:
 * - /webhook/whatsapp/*  → sem autenticação de usuário (é a Meta/Evolution
 *   API chamando, não um proprietário logado); usa service_role key
 *   internamente (ver 02-whatsapp-ia-servico.js) — é o único lugar
 *   onde isso é correto, porque não existe token de usuário nesse fluxo.
 * - Todo o resto → passa pelo middleware `autenticar`, que valida o
 *   token do Supabase Auth e escopa as queries por RLS.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');

const { autenticar } = require('./middleware/auth');
const rotasEstabelecimentos = require('./routes/estabelecimentos');
const rotasAtividades = require('./routes/atividades');
const rotasClientes = require('./routes/clientes');
const rotasProfissionais = require('./routes/profissionais');
const rotasAgenda = require('./routes/agenda');
const rotasComandas = require('./routes/comandas');
const rotasCaixa = require('./routes/caixa');
const rotasRelatorios = require('./routes/relatorios');
const rotasMetas = require('./routes/metas');
const rotasProprietarios = require('./routes/proprietarios');
const rotasAutomacoes = require('./routes/automacoes');
const rotasListaEspera = require('./routes/lista-espera');
const { iniciarScheduler } = require('./lib/automacoes/scheduler');
const rotaWhatsapp = require('./routes/whatsapp'); // wrapper do 02-whatsapp-ia-servico.js — ver nota no final deste arquivo
const rotaAvaliacoes = require('./routes/avaliacoes'); // pública -- cliente sem login avalia via link

const app = express();
app.set('trust proxy', 1); // Railway fica atrás de proxy -- necessário pro rate limit identificar IP real

// CSP padrão do helmet é 'self' em tudo -- mas public/ (servido como estático,
// ver app.use(express.static abaixo) carrega o supabase-js via CDN, fala
// direto com o Supabase (REST + Realtime via WebSocket), e o app inteiro
// (salon-v6.html, painel-proprietario.html, cadastro-real.html) é um único
// <script> inline, sem nonce. 'unsafe-inline' é necessário até esses HTMLs
// serem refatorados pra JS em arquivo separado -- sem isso o script inline
// inteiro é bloqueado e NADA da lógica da página roda, sem nenhum erro
// visível na UI (só uma rejeição de CSP no console). Achado testando o
// login de verdade no navegador.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'script-src': ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      'script-src-attr': ["'unsafe-inline'"], // onclick="..." inline, usado em todo o app
      'connect-src': ["'self'", 'https://*.supabase.co', 'wss://*.supabase.co'],
    },
  },
}));
app.use(cors());
app.use(express.json());
app.use(pinoHttp({
  redact: ['req.headers.authorization', 'req.headers.apikey'],
  autoLogging: { ignore: (req) => req.url === '/health' },
}));

// Limite geral: protege a API de tráfego automatizado/abuso (mesmo tipo de
// achado que já apareceu em outro projeto do usuário — API sem limite
// recebendo tentativa de terceiro). Webhook do WhatsApp tem limite próprio,
// mais generoso, porque é tráfego legítimo de um provedor externo.
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));

// ── Rota pública de checagem de saúde (útil para o Railway e para o "SISTEMA OK" do painel-admin.html) ──
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ── Arquivos estáticos do frontend (public/) — precisa vir antes de
// `autenticar`: as telas de login (salon-v6.html, painel-proprietario.html,
// cadastro-real.html) e a página pública de avaliação (avaliar.html) não
// têm token de usuário ainda quando são abertas. ──
app.use(express.static('public'));

// ── Webhook do WhatsApp — sem middleware de autenticação de usuário ──
// (rotaWhatsapp já define o caminho completo /webhook/whatsapp/:id
// internamente -- montar em '/webhook' aqui duplicava o prefixo e a
// rota nunca era alcançada de verdade. Bug pré-existente, achado pelo
// teste "não exige autenticação no webhook do WhatsApp". O rate limit
// fica restrito ao prefixo /webhook; o router é montado na raiz.)
app.use('/webhook', rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false }));
app.use(rotaWhatsapp);

// ── Avaliação — cliente sem login, avalia via link enviado após o atendimento ──
// (mesmo cuidado de escopo do webhook acima: o rate limit fica restrito ao
// prefixo /avaliacoes, o router é montado na raiz porque já define o
// caminho completo internamente.)
app.use('/avaliacoes', rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));
app.use(rotaAvaliacoes);

// ── A partir daqui, toda rota exige token válido do Supabase Auth ──
app.use(autenticar);

app.use('/estabelecimentos', rotasEstabelecimentos);
app.use('/', rotasAtividades); // já inclui o prefixo /estabelecimentos/:id/atividades internamente
app.use('/', rotasClientes);   // já inclui o prefixo /estabelecimentos/:id/clientes internamente
app.use('/', rotasProfissionais); // já inclui o prefixo /estabelecimentos/:id/profissionais internamente
app.use('/', rotasAgenda);     // já inclui o prefixo /estabelecimentos/:id/agendamentos internamente
app.use('/', rotasComandas);   // já inclui o prefixo /estabelecimentos/:id/comandas internamente
app.use('/', rotasCaixa);      // já inclui o prefixo /estabelecimentos/:id/caixa internamente
app.use('/', rotasRelatorios); // /relatorios/margem-rede e /estabelecimentos/:id/resumo-mensal
app.use('/', rotasMetas);      // já inclui o prefixo /estabelecimentos/:id/metas internamente
app.use('/', rotasProprietarios); // GET /proprietarios/me
app.use('/', rotasAutomacoes);    // já inclui o prefixo /estabelecimentos/:id/automacoes e /automacoes/:id internamente
app.use('/', rotasListaEspera);   // já inclui o prefixo /estabelecimentos/:id/lista-espera internamente

// ── Tratamento de erro genérico ──
app.use((err, req, res, next) => {
  req.log ? req.log.error(err) : console.error(err);
  res.status(500).json({ erro: 'Erro interno do servidor.' });
});

const PORTA = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORTA, () => console.log(`SalonOS API rodando na porta ${PORTA}`));
  iniciarScheduler();
}

module.exports = app;

/**
 * Nota sobre routes/whatsapp.js:
 * O arquivo 02-whatsapp-ia-servico.js (entregue anteriormente) já
 * exporta um `router` do Express pronto — ele só precisa ser copiado
 * para src/routes/whatsapp.js dentro deste projeto, sem alteração,
 * porque já foi escrito no formato `module.exports = router`.
 */
