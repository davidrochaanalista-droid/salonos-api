/**
 * SalonOS API — Middleware de bloqueio por status de assinatura
 * =================================================================
 * Monta DEPOIS de `autenticar` (reaproveita req.user). Usa um client
 * service_role dedicado (mesmo padrão de exigirAdmin.js) porque
 * precisa checar TODOS os estabelecimentos do proprietário, cruzando
 * a tabela `proprietarios` por user_id -- fora do que RLS libera pro
 * client escopado por token.
 *
 * Pula checagem em /admin/* de propósito: a conta de teste do David
 * é dona de um estabelecimento de teste E é admin -- se essa conta de
 * teste ficasse marcada como inadimplente/cancelada, o middleware não
 * pode trancar o próprio David fora do painel-admin.
 */

const { createClient } = require('@supabase/supabase-js');

const clienteServiceRole = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const STATUS_BLOQUEADOS = ['inadimplente', 'cancelado'];

async function verificarAssinatura(req, res, next) {
  if (req.path.startsWith('/admin')) return next();

  const { data: proprietario } = await clienteServiceRole
    .from('proprietarios')
    .select('id')
    .eq('user_id', req.user.id)
    .maybeSingle();

  // Sem proprietário ainda (ex: admin sem salão) -- deixa passar, o
  // RLS de cada rota já cuida do resto.
  if (!proprietario) return next();

  const { data: estabelecimentos } = await clienteServiceRole
    .from('estabelecimentos')
    .select('status_assinatura')
    .eq('proprietario_id', proprietario.id);

  // Ainda não tem nenhum estabelecimento (onboarding logo após o
  // convite) -- deixa passar, é assim que a pessoa cria o primeiro.
  if (!estabelecimentos || !estabelecimentos.length) return next();

  const algumLiberado = estabelecimentos.some((e) => !STATUS_BLOQUEADOS.includes(e.status_assinatura));
  if (algumLiberado) return next();

  res.status(402).json({ erro: 'Assinatura inadimplente ou cancelada. Fale com o suporte do SalonOS pra reativar o acesso.' });
}

module.exports = { verificarAssinatura };
