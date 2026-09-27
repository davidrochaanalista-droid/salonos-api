/**
 * SalonOS — Comprovante de pagamento antecipado recebido pelo WhatsApp
 * =====================================================================
 * Pedido do David (26/09/2026), ver database/39-comprovante-pagamento-antecipado.sql:
 * depois de confirmar o horário a IA oferece pagar antecipado pelo Pix;
 * quando o cliente manda o comprovante (imagem ou PDF), este módulo:
 *   1. acha o(s) agendamento(s) que ele está pagando -- os próximos,
 *      ainda não pagos, do dia mais próximo (serviços em sequência na
 *      mesma visita contam juntos);
 *   2. lê a imagem com o modelo de visão da Groq (é comprovante? valor?);
 *   3. se o valor lido for >= soma dos preços, marca pago_antecipado_em;
 *      se for menor, ilegível ou PDF (visão não lê PDF), guarda o
 *      comprovante e deixa a equipe conferir -- nunca marca pago no escuro;
 *   4. guarda o arquivo no bucket privado 'comprovantes' pro dono ver.
 *
 * ⚠️ "Pago" = comprovante lido pela IA, não confirmação bancária.
 *
 * Dependências entram por parâmetro (supabase/groq/evolution) pra poder
 * testar sem rede -- ver tests/comprovantes.test.js.
 */

const MODELO_VISAO = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b';
const BUCKET = 'comprovantes';
const FUSO = 'America/Sao_Paulo';

const diaLocal = (data) => new Date(data).toLocaleDateString('pt-BR', { timeZone: FUSO });

// Próximos agendamentos não pagos do cliente, só os do dia mais próximo.
async function buscarAgendamentosAPagar(supabase, { estabelecimentoId, clienteId }) {
  const { data, error } = await supabase
    .from('agendamentos')
    .select('id, inicio, estabelecimento_atividades(nome, preco)')
    .eq('estabelecimento_id', estabelecimentoId)
    .eq('cliente_id', clienteId)
    .in('status', ['agendado', 'confirmado'])
    .is('pago_antecipado_em', null)
    .gte('inicio', new Date().toISOString())
    .order('inicio', { ascending: true });
  if (error || !data?.length) return [];

  const primeiroDia = diaLocal(data[0].inicio);
  return data.filter(a => diaLocal(a.inicio) === primeiroDia);
}

// Agendamento com remarcação pedida (solicitar_remarcacao) e sinal ainda
// não pago -- o mais recente pedido, se houver mais de um.
async function buscarRemarcacaoPendente(supabase, { estabelecimentoId, clienteId }) {
  const { data, error } = await supabase
    .from('agendamentos')
    .select('id, inicio, sinal_remarcacao_valor, estabelecimento_atividades(nome, preco)')
    .eq('estabelecimento_id', estabelecimentoId)
    .eq('cliente_id', clienteId)
    .in('status', ['agendado', 'confirmado'])
    .not('remarcacao_solicitada_em', 'is', null)
    .is('sinal_remarcacao_pago_em', null)
    .gte('inicio', new Date().toISOString())
    .order('remarcacao_solicitada_em', { ascending: false })
    .limit(1);
  if (error || !data?.length || data[0].sinal_remarcacao_valor == null) return null;
  return data[0];
}

// Soma dos preços dos serviços; null se algum serviço não tem preço
// cadastrado (aí não dá pra comparar -- equipe confere).
function valorEsperado(agendamentos) {
  let total = 0;
  for (const a of agendamentos) {
    const preco = Number(a.estabelecimento_atividades?.preco);
    if (!Number.isFinite(preco) || preco <= 0) return null;
    total += preco;
  }
  return total;
}

// Lê a imagem com visão. Devolve { e_comprovante: true|false|null, valor: número|null }
// -- null em e_comprovante = não deu pra ler (PDF, falha da Groq, JSON inválido).
async function lerComprovante(groq, { base64, mimetype }) {
  if (!mimetype?.startsWith('image/')) return { e_comprovante: null, valor: null };
  try {
    const resposta = await groq.chat.completions.create({
      model: MODELO_VISAO,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Esta imagem é um comprovante de pagamento (Pix, transferência ou depósito)? Se for, extraia o valor pago em reais. Responda SOMENTE com JSON: {"e_comprovante": true ou false, "valor": número em reais (ex: 80.5) ou null se não estiver legível}' },
          { type: 'image_url', image_url: { url: `data:${mimetype};base64,${base64}` } },
        ],
      }],
      temperature: 0,
      max_tokens: 200,
      response_format: { type: 'json_object' },
    });
    const lido = JSON.parse(resposta.choices[0].message.content);
    const valor = Number(String(lido.valor ?? '').replace(',', '.'));
    return {
      e_comprovante: lido.e_comprovante === true ? true : lido.e_comprovante === false ? false : null,
      valor: Number.isFinite(valor) && valor > 0 ? valor : null,
    };
  } catch (erro) {
    console.error('Falha ao ler comprovante com visão:', erro.message);
    return { e_comprovante: null, valor: null };
  }
}

function extensaoPorMimetype(mimetype) {
  if (mimetype === 'application/pdf') return 'pdf';
  if (mimetype === 'image/png') return 'png';
  if (mimetype === 'image/webp') return 'webp';
  return 'jpg';
}

// Devolve { tratado: false } quando a mídia não é assunto de comprovante
// (sem agendamento a pagar, ou a visão disse que não é comprovante) --
// aí o webhook segue o fluxo normal. { tratado: true, resposta } quando
// tratou: o texto é o que vai pro cliente.
async function processarComprovante({ supabase, groq, evolution, estabelecimentoId, cliente, mensagemId, mimetype }) {
  // Remarcação pedida e sinal ainda não pago tem prioridade: o comprovante
  // que chega nessa hora é do sinal (src/lib/remarcacao.js).
  const remarcacao = await buscarRemarcacaoPendente(supabase, { estabelecimentoId, clienteId: cliente.id });
  const agendamentos = remarcacao ? [remarcacao] : await buscarAgendamentosAPagar(supabase, { estabelecimentoId, clienteId: cliente.id });
  if (!agendamentos.length) return { tratado: false };

  const primeiroNome = cliente.nome?.split(' ')[0] || '';
  const ids = agendamentos.map(a => a.id);
  const agora = new Date().toISOString();

  let midia = null;
  try {
    midia = await evolution.baixarMidiaBase64(estabelecimentoId, mensagemId);
  } catch (erro) {
    console.error('Falha ao baixar comprovante da Evolution API:', erro.message);
  }

  const leitura = midia?.base64
    ? await lerComprovante(groq, { base64: midia.base64, mimetype: midia.mimetype || mimetype })
    : { e_comprovante: null, valor: null };

  // Foto qualquer (a visão disse com certeza que não é comprovante).
  if (leitura.e_comprovante === false) return { tratado: false };

  let comprovantePath = null;
  if (midia?.base64) {
    const tipo = midia.mimetype || mimetype || 'image/jpeg';
    const caminho = `${estabelecimentoId}/${ids[0]}-${Date.now()}.${extensaoPorMimetype(tipo)}`;
    const { error } = await supabase.storage.from(BUCKET).upload(caminho, Buffer.from(midia.base64, 'base64'), { contentType: tipo });
    if (error) console.error('Falha ao guardar comprovante no Storage:', error.message);
    else comprovantePath = caminho;
  }

  const valorBate = (esperado) => leitura.e_comprovante === true && leitura.valor != null && esperado != null && leitura.valor + 0.009 >= esperado;

  if (remarcacao) {
    const sinalPago = valorBate(Number(remarcacao.sinal_remarcacao_valor));
    await supabase.from('agendamentos').update({
      comprovante_recebido_em: agora,
      comprovante_valor_lido: leitura.valor,
      comprovante_path: comprovantePath,
      sinal_remarcacao_pago_em: sinalPago ? agora : null,
    }).in('id', ids);
    return sinalPago
      ? { tratado: true, pago: true, resposta: `Recebido${primeiroNome ? ', ' + primeiroNome : ''}, muito obrigada! 😊\n\nSinal confirmado. Agora me conta: qual novo dia e horário fica melhor pra você?` }
      : { tratado: true, pago: false, resposta: `Recebi seu comprovante${primeiroNome ? ', ' + primeiroNome : ''}, obrigada! 😊\n\nA equipe só vai conferir o valor do sinal e já te chama por aqui pra seguir com a remarcação.` };
  }

  const pago = valorBate(valorEsperado(agendamentos));

  await supabase.from('agendamentos').update({
    comprovante_recebido_em: agora,
    comprovante_valor_lido: leitura.valor,
    comprovante_path: comprovantePath,
    pago_antecipado_em: pago ? agora : null,
  }).in('id', ids);

  if (pago) {
    const quando = new Date(agendamentos[0].inicio).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: FUSO });
    return {
      tratado: true,
      pago: true,
      resposta: `Recebido${primeiroNome ? ', ' + primeiroNome : ''}, muito obrigada! 😊\n\nJá deixei seu horário de ${quando} marcado como pago na agenda. Até lá! ✨`,
    };
  }
  return {
    tratado: true,
    pago: false,
    resposta: `Recebi seu comprovante${primeiroNome ? ', ' + primeiroNome : ''}, obrigada! 😊\n\nA equipe só vai conferir o valor e, qualquer coisa, te chama por aqui.`,
  };
}

module.exports = { processarComprovante, buscarAgendamentosAPagar, valorEsperado, lerComprovante };
