/**
 * SalonOS — Lista de espera em cascata pelo WhatsApp
 * ====================================================
 * Pedido do David (26/09/2026), ver database/40-lista-espera-cascata.sql.
 *
 *   liberarVaga            -- um horário ficou livre (cancelamento no painel,
 *                             remarcação pelo WhatsApp ou pelo painel):
 *                             oferece pro 1º da fila daquele serviço.
 *   oferecerProximo        -- manda a oferta pro próximo da fila que ainda
 *                             não recebeu ESSA vaga (e que não é quem liberou).
 *   tratarRespostaOferta   -- cliente respondeu: aceitou -> agenda sozinho;
 *                             recusou -> oferece pro próximo.
 *   expirarOfertas         -- scheduler de 1 em 1 min: oferta sem resposta
 *                             em 15 min expira e passa pro próximo.
 *   entrarNaListaEspera    -- ferramenta da IA (cliente sem vaga topa esperar).
 *
 * Só funciona com a automação "lista_espera" ativa no salão (toggle em
 * Automações, desligada por padrão). Tudo roda com service_role (a cascata
 * mexe em cliente de outra pessoa) -- a mensagem chega por `enviar`,
 * passado por quem chama, pra não criar require circular com routes/whatsapp.js.
 */

const { randomUUID } = require('crypto');
const { buscarConflitoAgendamento } = require('./disponibilidade');

const MINUTOS_PARA_RESPONDER = 15;
// Não oferece vaga que começa em menos que isso -- não daria tempo de vir.
const ANTECEDENCIA_MINIMA_MIN = 20;
const FUSO = 'America/Sao_Paulo';

const formatarQuando = (iso) => new Date(iso).toLocaleString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: FUSO });

async function buscarAutomacao(supabase, estabelecimentoId) {
  const { data } = await supabase
    .from('automacoes')
    .select('id, ativa')
    .eq('estabelecimento_id', estabelecimentoId)
    .eq('tipo', 'lista_espera')
    .maybeSingle();
  return data;
}

async function automacaoAtiva(supabase, estabelecimentoId) {
  const { data } = await supabase
    .from('automacoes')
    .select('ativa')
    .eq('estabelecimento_id', estabelecimentoId)
    .eq('tipo', 'lista_espera')
    .maybeSingle();
  return !!data?.ativa;
}

// `agendamento` = o agendamento cujo horário ficou livre, com os dados do
// horário ANTIGO (inicio/fim/profissional) -- no caso de remarcação, é o
// horário de antes da troca.
async function liberarVaga({ supabase, enviar, agendamento }) {
  if (!agendamento?.estabelecimento_atividade_id) return null;
  if (new Date(agendamento.inicio).getTime() - Date.now() < ANTECEDENCIA_MINIMA_MIN * 60000) return null;
  if (!(await automacaoAtiva(supabase, agendamento.estabelecimento_id))) return null;

  return oferecerProximo({
    supabase,
    enviar,
    vaga: {
      vaga_id: randomUUID(),
      estabelecimento_id: agendamento.estabelecimento_id,
      estabelecimento_atividade_id: agendamento.estabelecimento_atividade_id,
      profissional_id: agendamento.profissional_id || null,
      inicio: agendamento.inicio,
      fim: agendamento.fim,
      cliente_que_liberou_id: agendamento.cliente_id || null,
    },
  });
}

async function oferecerProximo({ supabase, enviar, vaga }) {
  if (new Date(vaga.inicio).getTime() - Date.now() < ANTECEDENCIA_MINIMA_MIN * 60000) return null;

  // A vaga ainda está livre? (alguém pode ter agendado pelo painel no meio da cascata)
  const conflito = await buscarConflitoAgendamento(supabase, { profissionalId: vaga.profissional_id, inicio: vaga.inicio, fim: vaga.fim });
  if (conflito) return null;

  const { data: jaOfertados } = await supabase
    .from('ofertas_horario_vago')
    .select('cliente_id')
    .eq('vaga_id', vaga.vaga_id);
  const excluidos = new Set((jaOfertados || []).map(o => o.cliente_id));
  if (vaga.cliente_que_liberou_id) excluidos.add(vaga.cliente_que_liberou_id);

  const { data: fila } = await supabase
    .from('lista_espera')
    .select('id, cliente_id, profissional_id, clientes(nome, telefone), estabelecimento_atividades(nome)')
    .eq('estabelecimento_id', vaga.estabelecimento_id)
    .eq('estabelecimento_atividade_id', vaga.estabelecimento_atividade_id)
    .is('atendido_em', null)
    .order('created_at', { ascending: true });

  // Preferência de profissional da fila é pra valer: só recebe a vaga quem
  // não tem preferência ou prefere justamente quem vai atender.
  const proximo = (fila || []).find(f =>
    !excluidos.has(f.cliente_id)
    && f.clientes?.telefone
    && (!f.profissional_id || !vaga.profissional_id || f.profissional_id === vaga.profissional_id));
  if (!proximo) return null;

  const agora = Date.now();
  const { data: oferta, error } = await supabase.from('ofertas_horario_vago').insert({
    vaga_id: vaga.vaga_id,
    estabelecimento_id: vaga.estabelecimento_id,
    lista_espera_id: proximo.id,
    cliente_id: proximo.cliente_id,
    estabelecimento_atividade_id: vaga.estabelecimento_atividade_id,
    profissional_id: vaga.profissional_id,
    inicio: vaga.inicio,
    fim: vaga.fim,
    cliente_que_liberou_id: vaga.cliente_que_liberou_id,
    expira_em: new Date(agora + MINUTOS_PARA_RESPONDER * 60000).toISOString(),
  }).select().single();
  if (error) {
    console.error('Falha ao registrar oferta de horário vago:', error.message);
    return null;
  }

  const primeiroNome = proximo.clientes.nome?.split(' ')[0];
  const servico = proximo.estabelecimento_atividades?.nome || 'o serviço que você estava esperando';
  const texto = `Oi${primeiroNome ? ', ' + primeiroNome : ''}! 😊 Boa notícia: abriu um horário pra ${servico} ${formatarQuando(vaga.inicio)}.\n\nQuer que eu reserve pra você?`;
  await enviar({ telefone: proximo.clientes.telefone, texto, estabelecimentoId: vaga.estabelecimento_id });
  await supabase.from('lista_espera').update({ notificado_em: new Date(agora).toISOString() }).eq('id', proximo.id);
  // Histórico do card de automação (mesmo registro que o disparo antigo fazia).
  const automacao = await buscarAutomacao(supabase, vaga.estabelecimento_id);
  if (automacao) {
    await supabase.from('automacao_disparos').insert({
      automacao_id: automacao.id, estabelecimento_id: vaga.estabelecimento_id, cliente_id: proximo.cliente_id, referencia_id: proximo.id,
    });
  }
  return oferta;
}

// Oferta pendente e ainda no prazo pra esse cliente (a mais recente).
async function buscarOfertaPendente(supabase, { estabelecimentoId, clienteId }) {
  const { data } = await supabase
    .from('ofertas_horario_vago')
    .select('*, estabelecimento_atividades(nome)')
    .eq('estabelecimento_id', estabelecimentoId)
    .eq('cliente_id', clienteId)
    .eq('status', 'pendente')
    .gt('expira_em', new Date().toISOString())
    .order('enviada_em', { ascending: false })
    .limit(1);
  return data?.[0] || null;
}

const vagaDaOferta = (o) => ({
  vaga_id: o.vaga_id, estabelecimento_id: o.estabelecimento_id, estabelecimento_atividade_id: o.estabelecimento_atividade_id,
  profissional_id: o.profissional_id, inicio: o.inicio, fim: o.fim, cliente_que_liberou_id: o.cliente_que_liberou_id,
});

// 'aceita' | 'recusa' | 'outro'. Groq primeiro; se falhar, regra simples
// que só decide nos casos óbvios (na dúvida, 'outro' -- nunca agenda no chute).
async function classificarResposta(groq, { mensagem, servico, quando }) {
  try {
    const r = await groq.chat.completions.create({
      model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
      messages: [{
        role: 'user',
        content: `Um salão ofereceu ao cliente um horário vago: ${servico}, ${quando}, perguntando se ele quer reservar. O cliente respondeu: "${mensagem}". Classifique: "aceita" (quer o horário), "recusa" (não quer/não pode) ou "outro" (dúvida, outro assunto, ou não dá pra saber). Responda SOMENTE com JSON: {"resposta":"aceita|recusa|outro"}`,
      }],
      temperature: 0,
      max_tokens: 200,
      response_format: { type: 'json_object' },
    });
    const { resposta } = JSON.parse(r.choices[0].message.content);
    if (['aceita', 'recusa', 'outro'].includes(resposta)) return resposta;
  } catch (erro) {
    console.error('Falha ao classificar resposta da oferta de horário vago:', erro.message);
  }
  const t = mensagem.trim().toLowerCase();
  if (/^(sim|quero|pode|pode sim|quero sim|claro|reserva|reserve|ok|fechado)\b/.test(t)) return 'aceita';
  if (/^(não|nao|n|não quero|nao quero|não posso|nao posso|dessa vez não)\b/.test(t)) return 'recusa';
  return 'outro';
}

// Devolve { tratado: false } quando a mensagem não é resposta à oferta
// (aí o webhook segue o fluxo normal da IA, e a oferta continua valendo
// até expirar). { tratado: true, resposta, agendamento? } quando tratou.
async function tratarRespostaOferta({ supabase, groq, enviar, oferta, mensagem, cliente, textoExtraConfirmacao }) {
  const servico = oferta.estabelecimento_atividades?.nome || 'atendimento';
  const quando = formatarQuando(oferta.inicio);
  const primeiroNome = cliente.nome?.split(' ')[0] || '';
  const classificacao = await classificarResposta(groq, { mensagem, servico, quando });
  if (classificacao === 'outro') return { tratado: false };

  const agora = new Date().toISOString();

  if (classificacao === 'recusa') {
    await supabase.from('ofertas_horario_vago').update({ status: 'recusada', respondida_em: agora }).eq('id', oferta.id);
    oferecerProximo({ supabase, enviar, vaga: vagaDaOferta(oferta) })
      .catch(erro => console.error('Falha ao oferecer vaga pro próximo da fila:', erro.message));
    return { tratado: true, resposta: `Sem problema${primeiroNome ? ', ' + primeiroNome : ''}! 😊 Você continua na nossa lista de espera e eu te aviso se abrir outro horário.` };
  }

  // Aceitou: confere de novo se ainda está livre e agenda de verdade.
  const conflito = await buscarConflitoAgendamento(supabase, { profissionalId: oferta.profissional_id, inicio: oferta.inicio, fim: oferta.fim });
  if (conflito || new Date(oferta.inicio) < new Date()) {
    await supabase.from('ofertas_horario_vago').update({ status: 'cancelada', respondida_em: agora }).eq('id', oferta.id);
    return { tratado: true, resposta: `Poxa${primeiroNome ? ', ' + primeiroNome : ''}, esse horário acabou de ser preenchido 😕 Você continua na lista de espera e eu te aviso assim que abrir outro.` };
  }

  const { data: agendamento, error } = await supabase.from('agendamentos').insert({
    estabelecimento_id: oferta.estabelecimento_id,
    cliente_id: oferta.cliente_id,
    profissional_id: oferta.profissional_id,
    estabelecimento_atividade_id: oferta.estabelecimento_atividade_id,
    inicio: oferta.inicio,
    fim: oferta.fim,
    status: 'confirmado',
    origem: 'whatsapp',
    observacao: 'Agendado pela lista de espera',
  }).select().single();
  if (error) {
    console.error('Falha ao agendar pela lista de espera:', error.message);
    return { tratado: true, resposta: `Anotado${primeiroNome ? ', ' + primeiroNome : ''}! Vou pedir pra equipe confirmar esse horário com você rapidinho 😊` };
  }

  await supabase.from('ofertas_horario_vago').update({ status: 'aceita', respondida_em: agora, agendamento_id: agendamento.id }).eq('id', oferta.id);
  await supabase.from('lista_espera').update({ atendido_em: agora }).eq('id', oferta.lista_espera_id);

  const partes = [`Oba${primeiroNome ? ', ' + primeiroNome : ''}! ${servico} ${quando} ficou confirmado pra você ✨`];
  if (textoExtraConfirmacao) partes.push(textoExtraConfirmacao);
  return { tratado: true, resposta: partes.join('\n\n'), agendamento };
}

// Scheduler: oferta sem resposta no prazo expira e a vaga vai pro próximo.
async function expirarOfertas({ supabase, enviar }) {
  const { data: vencidas, error } = await supabase
    .from('ofertas_horario_vago')
    .select('*')
    .eq('status', 'pendente')
    .lte('expira_em', new Date().toISOString());
  if (error) {
    console.error('Falha ao buscar ofertas vencidas:', error.message);
    return;
  }
  for (const oferta of vencidas || []) {
    // Update condicional: se o cliente respondeu no mesmo instante, não
    // sobrescreve a resposta dele nem dispara a cascata duas vezes.
    const { data: atualizada } = await supabase.from('ofertas_horario_vago')
      .update({ status: 'expirada' })
      .eq('id', oferta.id)
      .eq('status', 'pendente')
      .select('id');
    if (!atualizada?.length) continue;
    await oferecerProximo({ supabase, enviar, vaga: vagaDaOferta(oferta) })
      .catch(erro => console.error('Falha ao oferecer vaga expirada pro próximo:', erro.message));
  }
}

function iniciarSchedulerListaEspera({ supabase, enviar }) {
  const rodar = () => expirarOfertas({ supabase, enviar }).catch(erro => console.error('Falha em expirarOfertas:', erro));
  rodar(); // uma vez ao subir (mesma regra dos outros schedulers do projeto)
  setInterval(rodar, 60 * 1000);
}

// Ferramenta entrar_lista_espera da IA. Não duplica: se o cliente já está
// na fila daquele serviço, só confirma.
async function entrarNaListaEspera(supabase, { estabelecimentoId, clienteId, atividade, profissional, preferencia }) {
  if (!atividade) return { ok: false, motivo: 'serviço não encontrado no catálogo -- pergunte de novo qual serviço da lista' };
  if (!(await automacaoAtiva(supabase, estabelecimentoId))) {
    return { ok: false, motivo: 'a lista de espera automática não está ativada neste salão -- não ofereça lista de espera; diga que a equipe avisa se abrir vaga' };
  }

  const { data: existente } = await supabase
    .from('lista_espera')
    .select('id')
    .eq('estabelecimento_id', estabelecimentoId)
    .eq('cliente_id', clienteId)
    .eq('estabelecimento_atividade_id', atividade.id)
    .is('atendido_em', null)
    .limit(1);
  if (existente?.length) return { ok: true, ja_estava_na_fila: true };

  const { error } = await supabase.from('lista_espera').insert({
    estabelecimento_id: estabelecimentoId,
    cliente_id: clienteId,
    estabelecimento_atividade_id: atividade.id,
    profissional_id: profissional?.id || null,
    observacao: preferencia || null,
    origem: 'whatsapp',
  });
  if (error) return { ok: false, motivo: error.message };
  return { ok: true, entrou_na_fila: true };
}

module.exports = {
  liberarVaga, oferecerProximo, buscarOfertaPendente, tratarRespostaOferta, expirarOfertas,
  iniciarSchedulerListaEspera, entrarNaListaEspera, classificarResposta, MINUTOS_PARA_RESPONDER,
};
