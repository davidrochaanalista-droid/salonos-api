/**
 * SalonOS API — Cliente service_role compartilhado
 * ===================================================
 * Singleton com a service_role key -- ignora RLS, então só usar em
 * contextos que já validaram autorização por fora (ex: exigirAdmin.js,
 * ou criação de login de salão em estabelecimentos.js). Nunca expor
 * esse client num req.supabase normal de rota de salão.
 */

const { createClient } = require('@supabase/supabase-js');

module.exports = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
