/**
 * SalonOS API — Avaliações de atendimento
 * ==========================================
 * Rota pública (sem token de usuário) porque quem avalia é o CLIENTE do
 * salão, que não tem login no sistema — recebe um link (ex.: por
 * WhatsApp, depois do atendimento) e avalia direto, sem autenticação.
 * Por isso usa a service_role key e a função `registrar_avaliacao`
 * (SECURITY DEFINER) em vez de depender de RLS baseada em auth.uid().
 * Mesmo padrão de exceção que routes/whatsapp.js já usa.
 */

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// POST /avaliacoes — registra (ou atualiza) a nota de um atendimento
// Body: { atendimento_id, nota (1-5), comentario? }
router.post('/avaliacoes', async (req, res) => {
  const { atendimento_id, nota, comentario } = req.body;
  if (!atendimento_id || !nota) {
    return res.status(400).json({ erro: 'atendimento_id e nota são obrigatórios.' });
  }
  if (nota < 1 || nota > 5) {
    return res.status(400).json({ erro: 'nota precisa ser entre 1 e 5.' });
  }

  const { data, error } = await supabase.rpc('registrar_avaliacao', {
    p_atendimento_id: atendimento_id,
    p_nota: nota,
    p_comentario: comentario || null,
  });

  if (error) return res.status(400).json({ erro: error.message });
  res.status(201).json(data);
});

module.exports = router;
