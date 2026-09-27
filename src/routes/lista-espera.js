/**
 * SalonOS API — Lista de espera
 * ===============================
 * Cliente entra na fila pela equipe (painel, aqui) ou pela IA do WhatsApp
 * (ferramenta entrar_lista_espera). Quando um horário daquele serviço fica
 * livre, a cascata de ofertas pelo WhatsApp roda sozinha -- ver
 * src/lib/lista-espera.js e database/40-lista-espera-cascata.sql.
 */

const express = require('express');
const router = express.Router();

// POST /estabelecimentos/:id/lista-espera
router.post('/estabelecimentos/:id/lista-espera', async (req, res) => {
  const { cliente_id, estabelecimento_atividade_id, profissional_id, observacao } = req.body;
  if (!cliente_id || !estabelecimento_atividade_id) {
    return res.status(400).json({ erro: 'cliente_id e estabelecimento_atividade_id são obrigatórios.' });
  }

  const { data, error } = await req.supabase
    .from('lista_espera')
    .insert({ estabelecimento_id: req.params.id, cliente_id, estabelecimento_atividade_id, profissional_id: profissional_id || null, observacao, origem: 'painel' })
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.status(201).json(data);
});

// GET /estabelecimentos/:id/lista-espera?pendente=true
router.get('/estabelecimentos/:id/lista-espera', async (req, res) => {
  let consulta = req.supabase
    .from('lista_espera')
    .select('*, clientes(nome, telefone), estabelecimento_atividades(nome), profissionais(nome)')
    .eq('estabelecimento_id', req.params.id)
    .order('created_at');

  // Pendente = ainda na fila (não ganhou horário). Quem recebeu oferta e
  // recusou continua pendente -- notificado_em é só "último aviso".
  if (req.query.pendente === 'true') consulta = consulta.is('atendido_em', null);

  const { data, error } = await consulta;
  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

// DELETE /lista-espera/:id — tira o cliente da fila
router.delete('/lista-espera/:id', async (req, res) => {
  const { error } = await req.supabase.from('lista_espera').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ erro: error.message });
  res.status(204).end();
});

module.exports = router;
