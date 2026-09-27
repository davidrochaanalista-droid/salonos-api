/**
 * SalonOS API — Rotas de Agenda
 * ===============================
 * Agendamento é o que está marcado para o futuro (distinto de
 * `atendimentos`, que registra o que já aconteceu, e é criado
 * automaticamente quando uma comanda vinculada é fechada — ver
 * routes/comandas.js e a função `fechar_comanda` no banco).
 */

const express = require('express');
const { enviarMensagemWhatsApp } = require('./whatsapp');
const { registrarAcessoAuditoria } = require('../lib/auditoria');
const { estaNoPassado } = require('../lib/disponibilidade');
const supabaseAdmin = require('../lib/supabaseAdmin');
const { liberarVaga } = require('../lib/lista-espera');
const router = express.Router();

// POST /estabelecimentos/:id/agendamentos — criar agendamento
router.post('/estabelecimentos/:id/agendamentos', async (req, res) => {
  const { cliente_id, profissional_id, estabelecimento_atividade_id, inicio, fim, origem, observacao } = req.body;
  if (!cliente_id || !estabelecimento_atividade_id || !inicio || !fim) {
    return res.status(400).json({ erro: 'cliente_id, estabelecimento_atividade_id, inicio e fim são obrigatórios.' });
  }
  if (estaNoPassado(inicio)) {
    return res.status(400).json({ erro: 'Não é possível criar um agendamento numa data/hora que já passou.' });
  }

  const { data, error } = await req.supabase
    .from('agendamentos')
    .insert({
      estabelecimento_id: req.params.id,
      cliente_id, profissional_id, estabelecimento_atividade_id, inicio, fim,
      origem: origem || 'painel', observacao,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.status(201).json(data);

  dispararUpsell(req.supabase, req.params.id, data).catch(erro =>
    console.error('Falha ao disparar upsell de agendamento:', erro)
  );
});

// GET /estabelecimentos/:id/agendamentos?desde=&ate= — lista agendamentos num intervalo
router.get('/estabelecimentos/:id/agendamentos', async (req, res) => {
  const { desde, ate } = req.query;
  let consulta = req.supabase
    .from('agendamentos')
    .select('*, clientes(nome, telefone), profissionais(nome), estabelecimento_atividades(nome, duracao_min, preco)')
    .eq('estabelecimento_id', req.params.id)
    .order('inicio');

  if (desde) consulta = consulta.gte('inicio', desde);
  if (ate) consulta = consulta.lte('inicio', ate);

  const { data, error } = await consulta;
  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);

  registrarAcessoAuditoria(req.supabase, {
    estabelecimentoId: req.params.id,
    ator: req.user?.email || req.user?.id,
    operacao: 'read',
    tabela: 'clientes',
    detalhe: `Leitura de nome/telefone via agenda (${data.length} agendamento(s))`,
  });
});

// PATCH /agendamentos/:id — editar horário/status/profissional
router.patch('/agendamentos/:id', async (req, res) => {
  const camposPermitidos = ['profissional_id', 'inicio', 'fim', 'status', 'observacao'];
  const atualizacoes = {};
  for (const campo of camposPermitidos) {
    if (req.body[campo] !== undefined) atualizacoes[campo] = req.body[campo];
  }
  if (atualizacoes.inicio && estaNoPassado(atualizacoes.inicio)) {
    return res.status(400).json({ erro: 'Não é possível remarcar um agendamento pra uma data/hora que já passou.' });
  }

  // Métrica de "remarcados" pro painel-admin (database/37-remarcado-em.sql)
  // -- só conta a partir de agora, não existe histórico de antes disso.
  if (atualizacoes.inicio !== undefined || atualizacoes.fim !== undefined) {
    atualizacoes.remarcado_em = new Date().toISOString();
  }

  // Equipe marca/desmarca pago antecipado à mão -- ex: a IA leu o
  // comprovante com valor menor/ilegível e o dono conferiu no banco
  // (database/39-comprovante-pagamento-antecipado.sql).
  if (req.body.pago_antecipado !== undefined) {
    atualizacoes.pago_antecipado_em = req.body.pago_antecipado ? new Date().toISOString() : null;
  }

  // Horário antigo, pra oferecer pra lista de espera se o agendamento for
  // movido (o update abaixo sobrescreve inicio/fim).
  const moveuHorario = atualizacoes.inicio !== undefined || atualizacoes.fim !== undefined || atualizacoes.profissional_id !== undefined;
  const { data: antes } = moveuHorario
    ? await req.supabase.from('agendamentos').select('*').eq('id', req.params.id).single()
    : { data: null };

  const { data, error } = await req.supabase
    .from('agendamentos')
    .update(atualizacoes)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);

  // Horário liberado (cancelou ou mudou de lugar) -> lista de espera em
  // cascata pelo WhatsApp (src/lib/lista-espera.js). service_role: a
  // cascata mexe em cliente/oferta que não é do usuário logado.
  const vagaLiberada = atualizacoes.status === 'cancelado' ? data
    : (antes && ['agendado', 'confirmado'].includes(antes.status) ? antes : null);
  if (vagaLiberada) {
    liberarVaga({ supabase: supabaseAdmin, enviar: enviarMensagemWhatsApp, agendamento: vagaLiberada })
      .catch(erro => console.error('Falha ao disparar lista de espera:', erro));
  }
});

// GET /agendamentos/:id/comprovante — link temporário (10 min) pra ver o
// comprovante de pagamento antecipado mandado pelo WhatsApp. O select via
// req.supabase passa pelo RLS de agendamentos (só dono/login do salão
// daquele estabelecimento enxerga a linha); só depois disso o backend usa
// a service_role pra assinar o link -- o bucket é privado, sem policy.
router.get('/agendamentos/:id/comprovante', async (req, res) => {
  const { data, error } = await req.supabase
    .from('agendamentos')
    .select('comprovante_path')
    .eq('id', req.params.id)
    .single();

  if (error || !data) return res.status(404).json({ erro: 'Agendamento não encontrado.' });
  if (!data.comprovante_path) return res.status(404).json({ erro: 'Nenhum comprovante guardado pra esse agendamento.' });

  const { data: link, error: erroLink } = await supabaseAdmin.storage
    .from('comprovantes')
    .createSignedUrl(data.comprovante_path, 600);
  if (erroLink) return res.status(500).json({ erro: erroLink.message });
  res.json({ url: link.signedUrl });
});

// Manda uma sugestão de serviço extra assim que o salão cria um
// agendamento pro cliente (não existe agendamento self-service pelo
// cliente ainda -- então o "upsell no momento de agendar" vira isso:
// uma mensagem logo depois que o salão marca o horário).
async function dispararUpsell(supabase, estabelecimentoId, agendamento) {
  const { data: automacao } = await supabase
    .from('automacoes')
    .select('id, ativa')
    .eq('estabelecimento_id', estabelecimentoId)
    .eq('tipo', 'upsell_agendamento')
    .maybeSingle();
  if (!automacao?.ativa) return;

  const { data: jaDisparado } = await supabase
    .from('automacao_disparos')
    .select('id')
    .eq('automacao_id', automacao.id)
    .eq('referencia_id', agendamento.id)
    .limit(1);
  if (jaDisparado?.length) return;

  const { data: cliente } = await supabase.from('clientes').select('telefone, nome').eq('id', agendamento.cliente_id).single();
  if (!cliente?.telefone) return;

  const hora = new Date(agendamento.inicio).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const texto = `Agendamento confirmado pra ${hora}! Quer aproveitar e incluir outro serviço no mesmo horário? É só responder aqui que a gente vê a disponibilidade 💇`;
  await enviarMensagemWhatsApp({ telefone: cliente.telefone, texto, estabelecimentoId });
  await supabase.from('automacao_disparos').insert({
    automacao_id: automacao.id, estabelecimento_id: estabelecimentoId, cliente_id: agendamento.cliente_id, referencia_id: agendamento.id,
  });
}

module.exports = router;
