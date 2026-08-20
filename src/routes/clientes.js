/**
 * SalonOS API — Rotas de Clientes
 * =================================
 * Nota: campos sensíveis (observacoes_criptografadas) não são
 * expostos em texto plano aqui — a descriptografia em camada de
 * aplicação (blueprint-backend-salonos.md, seção 4) ainda precisa
 * ser ligada antes desta rota devolver esse campo decodificado.
 * Por enquanto, o campo fica de fora da resposta por padrão.
 */

const express = require('express');
const router = express.Router();

// GET /estabelecimentos/:id/clientes — lista clientes do estabelecimento
router.get('/estabelecimentos/:id/clientes', async (req, res) => {
  const { data, error } = await req.supabase
    .from('clientes')
    .select('id, nome, telefone, endereco, data_nascimento, estado_onboarding, ultima_interacao_em, created_at')
    .eq('estabelecimento_id', req.params.id)
    .order('ultima_interacao_em', { ascending: false });

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// GET /clientes/:id — detalhe de um cliente, incluindo resumo de memória da IA
router.get('/clientes/:id', async (req, res) => {
  const { data: cliente, error } = await req.supabase
    .from('clientes')
    .select('id, nome, telefone, endereco, data_nascimento, estado_onboarding, ultima_interacao_em, created_at')
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(404).json({ erro: 'Cliente não encontrado ou sem permissão de acesso.' });

  const { data: memoria } = await req.supabase
    .from('whatsapp_memoria_cliente')
    .select('resumo, total_interacoes, ultima_atualizacao')
    .eq('cliente_id', req.params.id)
    .maybeSingle();

  const { data: ultimoAtendimento } = await req.supabase
    .from('atendimentos')
    .select('data_atendimento, estabelecimento_atividades(nome), profissionais(nome)')
    .eq('cliente_id', req.params.id)
    .order('data_atendimento', { ascending: false })
    .limit(1)
    .maybeSingle();

  res.json({ ...cliente, memoria_ia: memoria || null, ultimo_atendimento: ultimoAtendimento || null });
});

module.exports = router;
