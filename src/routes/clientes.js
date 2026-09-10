/**
 * SalonOS API — Rotas de Clientes
 * =================================
 * Campo sensível (observacoes_criptografadas) é criptografado em
 * camada de aplicação (AES-256-GCM, ver src/lib/crypto.js e
 * docs/blueprint-backend-salonos.md, seção 4) antes de gravar, e
 * descriptografado só na resposta de GET /clientes/:id — a listagem
 * (GET /estabelecimentos/:id/clientes) não devolve esse campo, para
 * não descriptografar em lote sem necessidade.
 */

const express = require('express');
const { encryptSensitive, decryptSensitive } = require('../lib/crypto');
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
  const { data: clienteBruto, error } = await req.supabase
    .from('clientes')
    .select('id, nome, telefone, endereco, data_nascimento, estado_onboarding, ultima_interacao_em, created_at, observacoes_criptografadas')
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(404).json({ erro: 'Cliente não encontrado ou sem permissão de acesso.' });

  const { observacoes_criptografadas, ...cliente } = clienteBruto;
  let observacoes = null;
  try {
    observacoes = decryptSensitive(observacoes_criptografadas);
  } catch (e) {
    console.error(`Falha ao descriptografar observações do cliente ${cliente.id}:`, e.message);
  }
  cliente.observacoes = observacoes;

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

// PATCH /clientes/:id — editar dados do cliente, incluindo ficha técnica
// (fórmula/alergia/observação); o texto chega em `observacoes` e é
// criptografado antes de gravar em `observacoes_criptografadas`.
router.patch('/clientes/:id', async (req, res) => {
  const { nome, endereco, data_nascimento, observacoes } = req.body;
  const atualizacoes = {};
  if (nome !== undefined) atualizacoes.nome = nome;
  if (endereco !== undefined) atualizacoes.endereco = endereco;
  if (data_nascimento !== undefined) atualizacoes.data_nascimento = data_nascimento;
  if (observacoes !== undefined) atualizacoes.observacoes_criptografadas = encryptSensitive(observacoes);

  const { data, error } = await req.supabase
    .from('clientes')
    .update(atualizacoes)
    .eq('id', req.params.id)
    .select('id, nome, telefone, endereco, data_nascimento, estado_onboarding, ultima_interacao_em, created_at')
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

module.exports = router;
