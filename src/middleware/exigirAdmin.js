/**
 * SalonOS API — Middleware de autorização admin (painel-admin.html)
 * =====================================================================
 * Monta DEPOIS de `autenticar` (reaproveita req.user, não revalida o
 * JWT). Admin precisa ler dado cross-tenant (todas as contas da
 * plataforma), o que o padrão normal (req.supabase escopado por RLS ao
 * dono logado) não permite por design -- por isso este middleware, uma
 * vez confirmado que o usuário está na tabela `admins`, empresta um
 * client com a service_role key (req.supabaseAdmin). Esse client só é
 * usado dentro de src/routes/admin.js -- nunca deve vazar pras rotas
 * de salão, que continuam usando req.supabase (escopado por RLS).
 */

const clienteServiceRole = require('../lib/supabaseAdmin');

async function exigirAdmin(req, res, next) {
  const { data, error } = await clienteServiceRole
    .from('admins')
    .select('id')
    .eq('user_id', req.user.id)
    .maybeSingle();

  if (error || !data) {
    return res.status(403).json({ erro: 'Acesso restrito a administradores da SalonOS.' });
  }

  req.supabaseAdmin = clienteServiceRole;
  next();
}

module.exports = { exigirAdmin };
