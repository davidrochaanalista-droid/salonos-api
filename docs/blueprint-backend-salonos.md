# SalonOS — Blueprint de Backend Real
### Adaptado do padrão validado em produção no GiroCerto

Este documento traduz o gap #1 identificado em todas as análises anteriores — "protótipo sem backend" — em um plano de schema concreto, pronto para implementar em Node/Express + Supabase, seu stack padrão.

---

## 1. O problema de tenant do SalonOS é mais complexo que o do GiroCerto — e isso muda o schema

O GiroCerto tem um nível de isolamento: **motoboy/lojista dentro de um tenant**. O SalonOS tem **dois níveis simultâneos**:

```
rede (dono multi-unidades, ex: Roberta)
  └── salão (unidade, ex: Studio Beleza Pro)
        └── usuário (dona/gerente/profissional, ex: Camila)
              └── dado operacional (cliente, comanda, caixa, comissão)
```

Isso significa que o SalonOS precisa de **RLS em cascata** — não só "este dado pertence a este salão", mas "este usuário tem permissão neste salão E este salão pertence a esta rede que este usuário pode ver". O bug que o GiroCerto caçou (vazamento entre tenants, corrigido em 16 políticas) tem uma versão pior possível aqui: um profissional de um salão vendo ficha de cliente de outro salão da mesma rede — que é exatamente o tipo de erro que aparece só em produção, com dado real, se o schema nascer errado.

## 2. Schema núcleo (adaptado do padrão GiroCerto)

```sql
-- Nível 1: rede (dono multi-unidades)
create table redes (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  owner_user_id uuid references auth.users(id) not null,
  plano text default 'individual', -- individual | multi-unidades
  created_at timestamptz default now()
);

-- Nível 2: salão (unidade)
create table saloes (
  id uuid primary key default gen_random_uuid(),
  rede_id uuid references redes(id) not null,
  nome text not null,
  cidade text,
  bairro text,
  endereco text,
  cep text,
  latitude numeric,
  longitude numeric,
  cnpj text,
  whatsapp text,
  plano text default 'base', -- base | crescimento | escala
  created_at timestamptz default now()
);

-- Nível 3: vínculo usuário-salão com papel (a peça que falta em produtos genéricos)
create table usuarios_saloes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) not null,
  salao_id uuid references saloes(id) not null,
  papel text not null check (papel in ('dona','gerente','profissional')),
  ativo boolean default true,
  created_at timestamptz default now(),
  unique(user_id, salao_id)
);

-- Dado operacional: sempre amarrado a salao_id, nunca a rede_id direto
create table clientes (
  id uuid primary key default gen_random_uuid(),
  salao_id uuid references saloes(id) not null,
  nome text not null,
  telefone text,
  formula_capilar text,     -- criptografado em camada de aplicação (ver seção 4)
  alergias text,             -- criptografado em camada de aplicação
  observacoes text,          -- criptografado em camada de aplicação
  ltv numeric default 0,
  created_at timestamptz default now()
);
```

## 3. RLS em cascata — o padrão central deste documento

A função `SECURITY DEFINER` do GiroCerto (que resolveu a violação de RLS no signup) inspira a função helper abaixo, que resolve o problema de "salão pertence a rede que usuário pode ver":

```sql
-- Função helper: usuário tem acesso a este salão?
create or replace function usuario_tem_acesso_salao(p_salao_id uuid)
returns boolean
language sql security definer
as $$
  select exists (
    select 1 from usuarios_saloes
    where salao_id = p_salao_id
      and user_id = auth.uid()
      and ativo = true
  );
$$;

-- Função helper: usuário é dono da rede (visão multi-unidades)?
create or replace function usuario_e_dono_rede(p_rede_id uuid)
returns boolean
language sql security definer
as $$
  select exists (
    select 1 from redes
    where id = p_rede_id and owner_user_id = auth.uid()
  );
$$;

alter table clientes enable row level security;

create policy "acesso a clientes do proprio salao"
on clientes for all
using ( usuario_tem_acesso_salao(salao_id) );

alter table saloes enable row level security;

create policy "dono da rede ve todos os saloes da rede"
on saloes for select
using ( usuario_e_dono_rede(rede_id) );

create policy "usuario ve o salao onde trabalha"
on saloes for select
using ( usuario_tem_acesso_salao(id) );
```

**Por que isso importa mais que parece**: sem essas duas funções helper, cada tabela nova (comanda, caixa, avaliação, comissão) exige reescrever a mesma lógica de "será que este usuário pode ver este dado" — e é exatamente aí que o GiroCerto encontrou recursão infinita de RLS antes de consolidar em funções centrais. Nascer com o padrão certo evita repetir essa depuração.

## 4. Criptografia de dado sensível — o achado mais grave de toda a análise anterior

Ficha técnica (fórmula, alergia, observação) hoje aparece em texto plano no JS do protótipo. Em produção, isso precisa de criptografia em nível de aplicação (não só RLS — RLS protege contra outro usuário, não contra vazamento de backup ou dump de banco):

```javascript
// camada de aplicação, não no banco — usar pgcrypto ou lib como @supabase/vault
// ou simplesmente AES-256 na camada Node antes de persistir
const crypto = require('crypto');
function encryptSensitive(text, key) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return { iv: iv.toString('hex'), data: encrypted.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
}
```

## 5. Tempo real — LISTEN/NOTIFY, exatamente como validado no GiroCerto

O "Ao vivo" da topbar do SalonOS hoje é `setInterval` fake. O GiroCerto validou em produção um evento chegando em ~1,7s via LISTEN/NOTIFY na Session Pooler (porta 5432 — lembrar que a Transaction Pooler quebra LISTEN persistente, foi o bug já caçado lá):

```sql
create or replace function notificar_caixa_atualizado()
returns trigger language plpgsql as $$
begin
  perform pg_notify('caixa_' || NEW.salao_id::text, json_build_object(
    'tipo', 'entrada', 'valor', NEW.valor, 'hora', NEW.created_at
  )::text);
  return NEW;
end;
$$;

create trigger trg_caixa_notify
after insert on caixa_entradas
for each row execute function notificar_caixa_atualizado();
```

Isso destrava algo que nenhum concorrente do levantamento de mercado tem: **caixa do dia atualizando ao vivo entre dispositivos** — dona vendo o celular somar enquanto a profissional fecha a comanda no tablet, sem refresh.

## 6. Ordem de implementação recomendada

1. Schema núcleo + RLS em cascata (seções 2-3) — sem isso nada mais é seguro de construir em cima
2. Auth real (Supabase Auth, substituindo login fake) + trigger `SECURITY DEFINER` no signup (padrão idêntico ao do GiroCerto)
3. Criptografia de dado sensível (seção 4) — obrigatório antes de qualquer dado real de cliente entrar
4. LISTEN/NOTIFY para caixa/agenda/comanda (seção 5) — é onde o "ao vivo" deixa de ser fake
5. Deploy Railway (backend) + Vercel (dashboards) — mesmo split já validado no Torre e no GiroCerto
