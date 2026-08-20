/**
 * SalonOS API — Middleware de autenticação
 * ==========================================
 * Decisão de arquitetura importante: o login/cadastro em si acontece
 * no FRONT-END (os painéis HTML), usando @supabase/supabase-js
 * diretamente contra o Supabase Auth — não é este backend que "faz
 * login". O que este backend faz é VALIDAR o token JWT que o Supabase
 * já emitiu, e criar um cliente Supabase por requisição USANDO ESSE
 * TOKEN — não a service_role key.
 *
 * Por que isso importa: se toda rota usasse a service_role key, ela
 * ignora as políticas de RLS que já construímos (schema, seção 7).
 * Usando o token do próprio usuário, o Postgres aplica RLS
 * automaticamente — a rota de API não precisa reimplementar "este
 * usuário pode ver este estabelecimento?", o banco já garante isso.
 * É defesa em profundidade: mesmo um bug na rota não vaza dado de
 * outro estabelecimento.
 *
 * A service_role key só é usada em contextos SEM usuário logado —
 * como o webhook do WhatsApp (02-whatsapp-ia-servico.js), que já
 * está correto por não passar por este middleware.
 */

const { createClient } = require('@supabase/supabase-js');

async function autenticar(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ erro: 'Token de autenticação ausente.' });
  }

  const token = authHeader.replace('Bearer ', '');

  // Cliente escopado ao token do usuário — RLS entra em vigor automaticamente
  // em toda query feita com req.supabase daqui para frente.
  const supabaseEscopado = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: { user }, error } = await supabaseEscopado.auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ erro: 'Token inválido ou expirado.' });
  }

  req.user = user;
  req.supabase = supabaseEscopado;
  next();
}

module.exports = { autenticar };
