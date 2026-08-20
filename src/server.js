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

const { autenticar } = require('./middleware/auth');
const rotasEstabelecimentos = require('./routes/estabelecimentos');
const rotasAtividades = require('./routes/atividades');
const rotasClientes = require('./routes/clientes');
const rotaWhatsapp = require('./routes/whatsapp'); // wrapper do 02-whatsapp-ia-servico.js — ver nota no final deste arquivo

const app = express();
app.use(cors());
app.use(express.json());

// ── Rota pública de checagem de saúde (útil para o Railway e para o "SISTEMA OK" do painel-admin.html) ──
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ── Webhook do WhatsApp — sem middleware de autenticação de usuário ──
app.use('/webhook', rotaWhatsapp);

// ── A partir daqui, toda rota exige token válido do Supabase Auth ──
app.use(autenticar);

app.use('/estabelecimentos', rotasEstabelecimentos);
app.use('/', rotasAtividades); // já inclui o prefixo /estabelecimentos/:id/atividades internamente
app.use('/', rotasClientes);   // já inclui o prefixo /estabelecimentos/:id/clientes internamente

// ── Tratamento de erro genérico ──
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ erro: 'Erro interno do servidor.' });
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => console.log(`SalonOS API rodando na porta ${PORTA}`));

/**
 * Nota sobre routes/whatsapp.js:
 * O arquivo 02-whatsapp-ia-servico.js (entregue anteriormente) já
 * exporta um `router` do Express pronto — ele só precisa ser copiado
 * para src/routes/whatsapp.js dentro deste projeto, sem alteração,
 * porque já foi escrito no formato `module.exports = router`.
 */
