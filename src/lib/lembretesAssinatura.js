/**
 * SalonOS — Aviso de vencimento de assinatura pro dono do salão
 * =================================================================
 * Diferente do motor de automações (src/lib/automacoes/scheduler.js,
 * que manda mensagem do SALÃO pro CLIENTE dele) -- aqui é o SalonOS
 * avisando o DONO do salão que a assinatura dele está vencendo.
 * `vencimento_em` é definido manualmente pelo admin (PATCH
 * /admin/contas/:id), sem cobrança recorrente automática por trás.
 *
 * Roda como processo de fundo (service_role, sem usuário logado --
 * mesmo padrão de scheduler.js). Checagem a cada 6h é suficiente pra
 * um aviso de data (não precisa da granularidade de 15min do motor de
 * automações de cliente).
 */

const { createClient } = require('@supabase/supabase-js');
const { gerarCopiaECola } = require('./pix');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const INTERVALO_MS = 6 * 60 * 60 * 1000;
const LIMIARES_DIAS = [7, 3, 1, 0];

// Chave Pix do próprio SalonOS (recebe a mensalidade do dono do salão) --
// nada a ver com estabelecimentos.chave_pix, que é do salão pro cliente
// dele. Sem essa variável configurada, o aviso sai sem o Pix (só o texto).
function montarTrechoPix(valor) {
  const chavePix = process.env.SALONOS_CHAVE_PIX;
  if (!chavePix) return '';

  const copiaCola = gerarCopiaECola({
    chavePix,
    nomeEstabelecimento: 'SalonOS',
    cidade: process.env.SALONOS_CIDADE || 'BRASIL',
    valor,
  });
  if (!copiaCola) return '';

  const valorFormatado = valor ? ` (R$ ${valor.toFixed(2).replace('.', ',')})` : '';
  return `\n\nPix pra renovar${valorFormatado} -- copia e cola:\n${copiaCola}`;
}

async function verificarVencimentos() {
  const [{ data: estabelecimentos, error }, { data: precos }] = await Promise.all([
    supabase
      .from('estabelecimentos')
      .select('id, nome, plano, whatsapp_status, vencimento_em, vencimento_lembrete_enviado_dias, proprietarios(nome, telefone)')
      .not('vencimento_em', 'is', null),
    supabase.from('planos_precos').select('plano, valor_mensal'),
  ]);

  if (error) {
    console.error('Falha ao buscar vencimentos de assinatura:', error.message);
    return;
  }

  const valorPorPlano = Object.fromEntries((precos || []).map((p) => [p.plano, Number(p.valor_mensal)]));
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);

  for (const estabelecimento of estabelecimentos || []) {
    const vencimento = new Date(`${estabelecimento.vencimento_em}T00:00:00`);
    const diasRestantes = Math.round((vencimento - hoje) / (24 * 3600 * 1000));

    if (!LIMIARES_DIAS.includes(diasRestantes)) continue;
    if (estabelecimento.vencimento_lembrete_enviado_dias === diasRestantes) continue;

    const telefone = estabelecimento.proprietarios?.telefone;
    if (telefone && estabelecimento.whatsapp_status === 'conectado') {
      const valor = valorPorPlano[estabelecimento.plano];
      const trechoPix = montarTrechoPix(valor);
      const texto = (diasRestantes > 0
        ? `Oi, ${estabelecimento.proprietarios?.nome || 'tudo bem'}? Seu plano do SalonOS (${estabelecimento.nome}) vence em ${diasRestantes} dia(s). Fale com a gente pra renovar e não perder o acesso.`
        : `Oi, ${estabelecimento.proprietarios?.nome || 'tudo bem'}? Seu plano do SalonOS (${estabelecimento.nome}) vence hoje. Fale com a gente pra renovar e não perder o acesso.`
      ) + trechoPix;

      try {
        const { enviarMensagemWhatsApp } = require('../routes/whatsapp');
        await enviarMensagemWhatsApp({ telefone, texto, estabelecimentoId: estabelecimento.id });
      } catch (erro) {
        console.error(`Falha ao avisar vencimento por WhatsApp (${estabelecimento.nome}):`, erro.message);
      }
    }

    await supabase
      .from('estabelecimentos')
      .update({ vencimento_lembrete_enviado_dias: diasRestantes })
      .eq('id', estabelecimento.id);
  }
}

function iniciarSchedulerVencimento() {
  // Roda uma vez assim que o servidor sobe, além do intervalo -- sem
  // isso, todo restart (deploy, crash) abre uma janela morta de até
  // INTERVALO_MS (6h) sem nenhuma checagem de vencimento.
  const rodar = () => verificarVencimentos().catch((erro) => console.error('Falha em verificarVencimentos:', erro));
  rodar();
  setInterval(rodar, INTERVALO_MS);
}

module.exports = { iniciarSchedulerVencimento, verificarVencimentos };
