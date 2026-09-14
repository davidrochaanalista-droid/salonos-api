/**
 * SalonOS — Cliente da Evolution API (WhatsApp self-hosted, multi-instância)
 * ============================================================================
 * Cada salão tem sua própria "instância" no mesmo deploy do Evolution API
 * (nome determinístico "salon_{estabelecimento_id}") -- não é mais um único
 * número fixo pra toda a SalonOS (ver EVOLUTION_INSTANCE, agora obsoleta).
 *
 * Verificado contra a instância real em produção (Railway, 13/09/2026):
 * /instance/create, /instance/connectionState/:id e /chat/findContacts/:id
 * batem exatamente com o formato assumido aqui. ⚠️ Ainda não testado: o
 * ciclo completo de pareamento por QR (exige escanear com um celular de
 * verdade) e o payload exato do webhook de "connection.update" quando o
 * estado muda pra "open" (ver tratarAtualizacaoConexao em routes/whatsapp.js).
 */

function nomeInstancia(estabelecimentoId) {
  return `salon_${estabelecimentoId}`;
}

function configuracaoEvolution() {
  const baseUrl = process.env.EVOLUTION_API_URL;
  const apiKey = process.env.EVOLUTION_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}

async function chamarEvolution(caminho, opcoes = {}) {
  const config = configuracaoEvolution();
  if (!config) {
    const erro = new Error('EVOLUTION_API_URL/EVOLUTION_API_KEY não configurados.');
    erro.evolutionNaoConfigurada = true;
    throw erro;
  }

  const resposta = await fetch(`${config.baseUrl}${caminho}`, {
    ...opcoes,
    headers: { 'Content-Type': 'application/json', apikey: config.apiKey, ...(opcoes.headers || {}) },
  });

  if (!resposta.ok) {
    const corpo = await resposta.text().catch(() => '');
    const erro = new Error(`Evolution API respondeu ${resposta.status}: ${corpo}`);
    erro.status = resposta.status;
    throw erro;
  }

  return resposta.json();
}

// Cria a instância se ainda não existir e já registra o webhook de eventos
// (mensagens + status de conexão) apontando pro nosso próprio backend.
async function criarOuReconectarInstancia(estabelecimentoId) {
  const instancia = nomeInstancia(estabelecimentoId);
  const baseUrlPublica = process.env.PUBLIC_BASE_URL;

  try {
    await chamarEvolution('/instance/create', {
      method: 'POST',
      body: JSON.stringify({
        instanceName: instancia,
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
        webhook: baseUrlPublica ? {
          url: `${baseUrlPublica}/webhook/whatsapp/${estabelecimentoId}`,
          events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
        } : undefined,
      }),
    });
  } catch (erro) {
    // Instância já existe -- segue pro /connect abaixo pra pegar um QR novo.
    if (erro.status !== 403 && erro.status !== 409) throw erro;
  }

  return buscarQrCode(estabelecimentoId);
}

// Retorna o QR code (base64) pra escanear. Chamar de novo depois que o
// anterior expirar gera um QR novo -- Evolution não exige recriar a
// instância pra isso.
async function buscarQrCode(estabelecimentoId) {
  const instancia = nomeInstancia(estabelecimentoId);
  const dados = await chamarEvolution(`/instance/connect/${instancia}`, { method: 'GET' });
  return dados?.base64 || dados?.qrcode?.base64 || null;
}

async function statusConexao(estabelecimentoId) {
  const instancia = nomeInstancia(estabelecimentoId);
  const dados = await chamarEvolution(`/instance/connectionState/${instancia}`, { method: 'GET' });
  return dados?.instance?.state || dados?.state || 'close';
}

async function desconectarInstancia(estabelecimentoId) {
  const instancia = nomeInstancia(estabelecimentoId);
  await chamarEvolution(`/instance/logout/${instancia}`, { method: 'DELETE' });
}

// Contatos salvos na agenda do celular conectado (não é o histórico de
// conversas) -- é a lista que o dono pode escolher importar como clientes.
async function buscarContatosSalvos(estabelecimentoId) {
  const instancia = nomeInstancia(estabelecimentoId);
  const dados = await chamarEvolution(`/chat/findContacts/${instancia}`, {
    method: 'POST',
    body: JSON.stringify({}),
  });

  return (Array.isArray(dados) ? dados : [])
    .filter(c => c.id && !c.id.endsWith('@g.us') && !c.id.startsWith('status@'))
    .map(c => ({
      nome: c.pushName || c.name || null,
      telefone: c.id.replace('@s.whatsapp.net', ''),
    }))
    .filter(c => c.telefone);
}

async function enviarTexto(estabelecimentoId, telefone, texto) {
  const instancia = nomeInstancia(estabelecimentoId);
  await chamarEvolution(`/message/sendText/${instancia}`, {
    method: 'POST',
    body: JSON.stringify({ number: telefone, text: texto }),
  });
}

module.exports = {
  nomeInstancia,
  evolutionConfigurada: () => !!configuracaoEvolution(),
  criarOuReconectarInstancia,
  buscarQrCode,
  statusConexao,
  desconectarInstancia,
  buscarContatosSalvos,
  enviarTexto,
};
