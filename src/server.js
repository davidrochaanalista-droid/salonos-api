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
const rotaWhatsapp = require('./routes/whatsapp'); // wrapper do 02-whatsapp-ia-servico.js — ver nota no final deste arquivo

const app = express();
app.set('trust proxy', 1); // Railway fica atrás de proxy -- necessário pro rate limit identificar IP real

app.use(helmet());
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

// ── Webhook do WhatsApp — sem middleware de autenticação de usuário ──
// (rotaWhatsapp já define o caminho completo /webhook/whatsapp/:id
// internamente -- montar em '/webhook' aqui duplicava o prefixo e a
// rota nunca era alcançada de verdade. Bug pré-existente, achado pelo
// teste "não exige autenticação no webhook do WhatsApp". O rate limit
// fica restrito ao prefixo /webhook; o router é montado na raiz.)
app.use('/webhook', rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false }));
app.use(rotaWhatsapp);

// ── A partir daqui, toda rota exige token válido do Supabase Auth ──
app.use(autenticar);

app.use('/estabelecimentos', rotasEstabelecimentos);
app.use('/', rotasAtividades); // já inclui o prefixo /estabelecimentos/:id/atividades internamente
app.use('/', rotasClientes);   // já inclui o prefixo /estabelecimentos/:id/clientes internamente
app.use('/', rotasProfissionais); // já inclui o prefixo /estabelecimentos/:id/profissionais internamente
app.use('/', rotasAgenda);     // já inclui o prefixo /estabelecimentos/:id/agendamentos internamente
app.use('/', rotasComandas);   // já inclui o prefixo /estabelecimentos/:id/comandas internamente
app.use('/', rotasCaixa);      // já inclui o prefixo /estabelecimentos/:id/caixa internamente
app.use('/', rotasRelatorios); // /relatorios/margem-rede

// ── Tratamento de erro genérico ──
app.use((err, req, res, next) => {
  req.log ? req.log.error(err) : console.error(err);
  res.status(500).json({ erro: 'Erro interno do servidor.' });
});

const PORTA = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORTA, () => console.log(`SalonOS API rodando na porta ${PORTA}`));
}

module.exports = app;

/**
 * Nota sobre routes/whatsapp.js:
 * O arquivo 02-whatsapp-ia-servico.js (entregue anteriormente) já
 * exporta um `router` do Express pronto — ele só precisa ser copiado
 * para src/routes/whatsapp.js dentro deste projeto, sem alteração,
 * porque já foi escrito no formato `module.exports = router`.
 */
