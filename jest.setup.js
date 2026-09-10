// Variáveis dummy só para os módulos carregarem em teste (nenhum teste
// aqui bate na rede/Supabase de verdade -- ver tests/server.test.js).
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy-test.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy-service-key';
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'dummy-groq-key';
process.env.CRYPTO_KEY = process.env.CRYPTO_KEY || '0'.repeat(64);
