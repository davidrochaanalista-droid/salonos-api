/**
 * SalonOS — Log de auditoria de acesso a dado sensível (LGPD)
 * ================================================================
 * Registra leitura/escrita/exportação de dado de cliente (nome, endereço,
 * data de nascimento, telefone, ficha técnica) -- é a prova concreta por
 * trás da promessa de segurança feita ao cliente final (ver painel-admin,
 * aba Auditoria & LGPD). Fire-and-forget, mesmo espírito de
 * enviarMensagemWhatsApp (routes/whatsapp.js): uma falha aqui nunca pode
 * derrubar a rota principal que estava só tentando registrar o acesso.
 */

async function registrarAcessoAuditoria(supabaseClient, { estabelecimentoId, ator, operacao, tabela, registroId, detalhe }) {
  if (!estabelecimentoId) return;
  try {
    const { error } = await supabaseClient.from('auditoria_acessos').insert({
      estabelecimento_id: estabelecimentoId,
      ator: ator || 'desconhecido',
      operacao,
      tabela,
      registro_id: registroId || null,
      detalhe: detalhe || null,
    });
    if (error) console.error('Falha ao registrar auditoria:', error.message);
  } catch (erro) {
    console.error('Falha ao registrar auditoria:', erro.message);
  }
}

module.exports = { registrarAcessoAuditoria };
