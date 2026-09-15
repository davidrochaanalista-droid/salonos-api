/**
 * SalonOS — Adapter de gateway: Efí / Gerencianet (Pix dinâmico)
 * ====================================================================
 * Estruturalmente diferente dos outros dois: autenticação por mTLS
 * (certificado .p12 do próprio dono, gerado uma vez no dashboard Efí e
 * enviado no Config do SalonOS -- guardado como base64 dentro do JSON
 * cifrado, junto de client_id/client_secret) -- não é só um token de
 * texto. O client_id+client_secret autentica via HTTP Basic dentro da
 * conexão mTLS pra trocar por um access_token OAuth2 (client_credentials),
 * que também exige a mesma conexão mTLS nas chamadas seguintes.
 *
 * Webhook: a verificação "de livro" da Efí é mTLS de novo (o servidor
 * deles conecta apresentando certificado, e o nosso validaria contra a
 * CA da Efí) -- isso é incerto de configurar corretamente atrás do
 * proxy/terminador de TLS do Railway (provavelmente o certificado de
 * cliente nem chega até o processo Node). Por isso o webhook da Efí
 * confia no allowlist de IP conhecido da Efí em vez de mTLS na
 * aplicação -- mais fraco que os outros dois adapters, documentado
 * como alternativa pela própria Efí. Se um dia o Railway suportar
 * passar o certificado de cliente adiante, dá pra reforçar isso.
 *
 * IMPORTANTE: a checagem de IP usa `req.ip`, nunca o header
 * X-Forwarded-For bruto -- lido direto, o primeiro valor do header é o
 * que o PRÓPRIO cliente da requisição manda, então qualquer um poderia
 * forjar `X-Forwarded-For: 34.193.116.226` e passar pela checagem. O
 * `req.ip` do Express respeita o `app.set('trust proxy', 1)` já
 * configurado em server.js (Railway = 1 hop confiável) e resolve o IP
 * real corretamente -- mesmo mecanismo que já protege o rate limit.
 */

const https = require('https');

const HOST = 'pix.api.efipay.com.br';
// IPs publicados pela Efí pra origem de webhook -- ver docs/webhooks.
const IPS_EFI = ['34.193.116.226'];

function agenteMtls(certificadoBase64) {
  return new https.Agent({ pfx: Buffer.from(certificadoBase64, 'base64') });
}

function requisicaoJson({ agent, method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const dados = body ? JSON.stringify(body) : undefined;
    const req = https.request(
      { hostname: HOST, path, method, agent, headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let bruto = '';
        res.on('data', (chunk) => { bruto += chunk; });
        res.on('end', () => {
          let json = {};
          try { json = bruto ? JSON.parse(bruto) : {}; } catch { /* resposta não-JSON, json fica vazio */ }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(new Error(json.mensagem || json.error_description || `Efí devolveu ${res.statusCode}`));
        });
      }
    );
    req.on('error', reject);
    if (dados) req.write(dados);
    req.end();
  });
}

async function obterToken(credenciais) {
  const agent = agenteMtls(credenciais.certificado_base64);
  const basic = Buffer.from(`${credenciais.client_id}:${credenciais.client_secret}`).toString('base64');
  const resposta = await requisicaoJson({
    agent,
    method: 'POST',
    path: '/oauth/token',
    headers: { Authorization: `Basic ${basic}` },
    body: { grant_type: 'client_credentials' },
  });
  return { agent, accessToken: resposta.access_token };
}

async function criarCobranca({ credenciais, valor, comandaId, descricao }) {
  const { agent, accessToken } = await obterToken(credenciais);
  const headersAuth = { Authorization: `Bearer ${accessToken}` };

  const cob = await requisicaoJson({
    agent,
    method: 'POST',
    path: '/v2/cob',
    headers: headersAuth,
    body: {
      calendario: { expiracao: 3600 },
      valor: { original: Number(valor).toFixed(2) },
      chave: credenciais.chave_pix_recebedor,
      solicitacaoPagador: descricao || `Comanda ${comandaId}`,
    },
  });

  const qr = await requisicaoJson({ agent, method: 'GET', path: `/v2/loc/${cob.loc.id}/qrcode`, headers: headersAuth });

  return {
    cobrancaIdExterno: cob.txid,
    copiaCola: qr.qrcode,
    qrDataUrl: qr.imagemQrcode || null,
  };
}

// Sem esquema de assinatura HTTP padrão -- confia no IP de origem
// conhecido da Efí (ver aviso no cabeçalho do arquivo -- por que é
// req.ip e não o header bruto).
function verificarWebhook(req) {
  return IPS_EFI.includes(req.ip);
}

async function extrairEventoPago(req) {
  const itens = req.body?.pix;
  if (!Array.isArray(itens) || !itens.length) return null;
  // A Efí só notifica pix[] quando o pagamento de fato ocorreu -- não
  // existe um campo "status" separado pra checar aqui, a própria
  // presença do evento já significa dinheiro recebido.
  return { cobrancaIdExterno: itens[0].txid, aprovado: true };
}

module.exports = { criarCobranca, verificarWebhook, extrairEventoPago };
