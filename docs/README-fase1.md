# SalonOS — Fase 1: Cadastro + IA no WhatsApp

## O que este pacote entrega

1. `01-schema-fase1.sql` — schema completo pronto para colar no SQL Editor do Supabase: proprietário, estabelecimento, segmento, catálogo de atividades, clientes, memória de conversa do WhatsApp, e RLS em cascata (mesmo padrão do `blueprint-backend-salonos.md` já entregue).
2. `02-whatsapp-ia-servico.js` — serviço Express que recebe mensagem do WhatsApp, monta contexto (dados do estabelecimento + memória do cliente), chama a IA e responde.

## Decisão 1 — "a IA oferece opções de atividades": catálogo curado, não geração livre

O pedido descreve a IA sugerindo atividades quando o proprietário escolhe um segmento. Na prática, a versão mais confiável disso **não é a IA gerando a lista toda vez** — é um catálogo fixo por segmento (tabela `atividades_catalogo`), que:
- não tem custo de API a cada cadastro
- não varia entre dois donos de barbearia (mesma pergunta, mesma resposta)
- pode ser revisado e melhorado por você ao longo do tempo, como um produto de verdade

A tela de cadastro filtra o catálogo pelo `segmento_id` escolhido, mostra tudo pré-marcado, e o proprietário confirma, remove ou adiciona o que quiser (vira registro em `estabelecimento_atividades`, vinculado ou não a um item do catálogo). Só o segmento "Cabeleireiro" está com exemplo de seed no SQL — os outros 8 segmentos precisam do mesmo tratamento antes de ir para produção.

Onde a IA generativa entra de verdade: quando o proprietário cadastra uma atividade que não está em nenhum catálogo (segmento muito específico, ou serviço novo do mercado). Aí sim vale uma chamada de IA para sugerir descrição, duração e faixa de preço — mas como exceção, não como regra.

## Decisão 2 — IA do WhatsApp: Groq + Llama 3.3 70B

Comparei as opções gratuitas relevantes em agosto/2026:

| Provedor | Gratuito sem cartão | Limite diário | Usa prompt para treinar? | Observação |
|---|---|---|---|---|
| **Groq (Llama 3.3 70B)** | Sim | ~14.400 requisições/dia (varia por modelo) | Não | SDK compatível com OpenAI, resposta muito rápida |
| Google Gemini (Flash) | Sim | ~1.500 requisições/dia | **Sim, no tier gratuito** | Mais generoso em tokens/minuto, mas guarda o direito de treinar com os prompts |
| Self-hosted (Ollama) | Sim, mas precisa de servidor/GPU | Sem limite | Não | Zero custo de API, mas exige infraestrutura própria — não recomendado para começar sozinho |

**Por que Groq**: dado que a conversa vai conter telefone e possivelmente preferência/observação de cliente, evitar um provedor que reserva o direito de treinar com esse conteúdo é coerente com tudo que já construímos sobre segurança de dado como diferencial (ver `SalonOS-estrategia-diferenciacao-2026.md`, Eixo 2). Se o volume de mensagens crescer além do limite diário gratuito, a migração para o tier pago do Groq é só trocar a variável de ambiente da chave — o código não muda.

## Decisão 3 — memória: resumo vivo, não histórico infinito

Duas tabelas fazem esse trabalho:
- `whatsapp_mensagens` — histórico bruto, guardado para auditoria (aparece no painel-admin, seção Auditoria & LGPD)
- `whatsapp_memoria_cliente` — um resumo de 2-4 frases por cliente, atualizado a cada 6 interações (não a cada mensagem, para não gerar custo/latência desnecessários)

Isso é o que faz a resposta ficar "mais precisa a cada conversa", como pedido: a cada atualização, a IA lê o resumo anterior + as mensagens recentes e gera um resumo novo — sem precisar reenviar o histórico inteiro a cada pergunta do cliente.

## Decisão 4 — Cliente novo: onboarding conduzido, não pergunta solta

A partir de agora o fluxo é determinístico (não deixado à "criatividade" da IA, que poderia esquecer de perguntar):

1. Primeiro contato → IA cumprimenta e pede o nome (telefone já veio do número do WhatsApp)
2. Cliente responde → sistema extrai o nome (com ajuda leve da IA, para lidar com respostas tipo "pode ser João Pedro Silva" em vez de só "João Pedro Silva") → pergunta o endereço
3. Cliente responde o endereço → sistema salva → libera a conversa livre

**Aniversário é pedido de forma leve, não bloqueante** — perguntar data de nascimento como item obrigatório do primeiro contato pode soar invasivo antes de qualquer relação de confiança. A IA menciona que o cliente *pode* informar depois, e o campo (`clientes.data_nascimento`) já existe no schema pronto para quando isso acontecer, seja pela conversa ou por um cadastro complementar no painel. Se você preferir tornar isso obrigatório desde o primeiro contato, é só me avisar — é uma mudança pequena no fluxo.

## Decisão 5 — Cliente existente: "mesmo procedimento ou outro?"

Isso só é confiável se vier de um dado real, não da "memória" da IA (que pode alucinar). Por isso a migração `03-migracao-onboarding-historico.sql` cria:
- `profissionais` — quem atende no estabelecimento
- `atendimentos` — histórico de verdade: qual cliente fez qual atividade com qual profissional e quando

Quando um cliente com cadastro completo escreve depois de um intervalo de **4 horas ou mais** desde a última mensagem (configurável via `SESSAO_GAP_HORAS` no código — esse número é um ponto de partida, ajuste conforme observar o comportamento real dos clientes), o sistema busca o último registro em `atendimentos` e instrui a IA a perguntar, antes de qualquer outra coisa: repetir o mesmo procedimento com a mesma profissional, ou fazer algo diferente desta vez.

**Importante**: a tabela `atendimentos` só se popula quando alguém de fato registra que o atendimento aconteceu — hoje isso não tem uma tela dedicada. Duas formas de alimentar essa tabela, a decidir:
- Automaticamente, quando um agendamento feito pela IA no WhatsApp é confirmado (depende do fluxo de agendamento, que é uma fase seguinte, listada abaixo)
- Manualmente, quando a profissional fecha a comanda no `salon-v6.html` (o que já existe ali seria o ponto natural de gravar um registro em `atendimentos`)

Sem isso, a pergunta "mesmo ou outro?" nunca vai ter dado para se basear — vale decidir essa integração antes de colocar em produção.

## Decisão 6 — Catálogo expandido: 18 segmentos, com uma linha de corte importante

`04-catalogo-completo-segmentos.sql` completa o catálogo de todos os segmentos (os 8 que já existiam sem atividades + 9 novos: Tatuagem/Piercing, Bronzeamento, Extensão de Cílios, Nutricionista, Psicologia, Personal Trainer, Terapias Holísticas, Odontologia, Fisioterapia). 83 atividades ao todo.

**Ponto que precisa da sua decisão consciente antes de vender para esses últimos segmentos**: Nutricionista, Psicologia, Odontologia e Fisioterapia são serviços de saúde regulados por conselho profissional (CFN, CFP, CFO, COFFITO respectivamente). Diferente de um corte de cabelo, esses atendimentos geram **prontuário clínico** — e a LGPD trata dado de saúde como categoria **sensível** (Art. 11), com exigência de base legal mais restrita e cuidado redobrado de segurança, diferente do que já vale para preferência estética.

O catálogo que entreguei cobre só **agendamento** (nome do procedimento, duração, faixa de preço) — propositalmente **não inclui**: prontuário eletrônico, odontograma (mapa dentário), evolução de sessão de fisioterapia, anotação de sessão de terapia, diagnóstico. Isso significa que, hoje, o SalonOS serve esses segmentos do mesmo jeito que serve um salão — agenda, confirmação por WhatsApp, cadastro de cliente. Não serve como sistema de prontuário.

**Três caminhos possíveis, a decidir**:
1. Vender para esses segmentos só a parte de agendamento, sendo transparente que não substitui o prontuário que eles já usam (mais rápido, menor risco)
2. Não vender para esses segmentos ainda, focar 100% em beleza/estética/bem-estar até a base estar mais madura (mais conservador)
3. Investir em construir prontuário clínico de verdade mais adiante — isso é um produto à parte, com exigências de segurança mais altas que tudo que já construímos, e não é uma extensão simples do schema atual

Recomendo o caminho 1 para começar: entra no catálogo, mas a IA do WhatsApp para esses segmentos deveria ter uma instrução extra no `system prompt` deixando claro que ela agenda, não dá orientação clínica nem substitui prontuário — isso ainda não está implementado no `02-whatsapp-ia-servico.js`, é um ajuste pequeno se você confirmar essa direção.

1. Criar o projeto no Supabase (se ainda não existir um dedicado ao SalonOS) e colar o `01-schema-fase1.sql` no SQL Editor.
2. Criar conta gratuita na Groq (console.groq.com) e gerar a `GROQ_API_KEY`.
3. Escolher o provedor de WhatsApp:
   - **Evolution API** (open-source, self-hosted, sem custo por mensagem, mas você mantém o servidor) — mais alinhado ao seu perfil de dev solo com Railway
   - **WhatsApp Cloud API oficial da Meta** (gratuito até certo volume de conversas/mês, depois cobra por conversa) — mais estável a longo prazo, exige verificação de negócio
4. Preencher os dois stubs no final de `02-whatsapp-ia-servico.js` (`extrairMensagem` e `enviarMensagemWhatsApp`) conforme o formato de payload do provedor escolhido.
5. Decidir o caminho da Decisão 6 (acima) antes de divulgar os segmentos de saúde regulada.

## O que ainda não está aqui (fases seguintes)

- Criptografia de campo sensível (`clientes.observacoes_criptografadas`) — a função `encryptSensitive` já está especificada no `blueprint-backend-salonos.md`, falta ligar no fluxo de escrita
- Fluxo de agendamento de fato (a IA hoje responde dúvida, mas não bloqueia horário na agenda — isso é a próxima peça depois que o cadastro básico estiver rodando)
- Integração do log de mensagens com a tela de Auditoria do `painel-admin.html` (hoje são dados mockados lá, precisam vir de `whatsapp_mensagens`)
