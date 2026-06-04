# Notas de Producao — ZAP-FLAGS 3.1

## Painel de Controlo da Empresa (Dashboard)

### Rota API

**`GET /api/company/dashboard`** — requer JWT com `account_type = 'company'`.

Resposta:
```json
{
  "success": true,
  "dashboard": {
    "active_flags": 3,
    "total_captures": 12,
    "total_coins_distributed": 450,
    "total_flags": 15,
    "recent_captures": [
      {
        "flag_id": 7,
        "type": "Coin",
        "coin_value": 25,
        "captured_at": "2026-06-03T10:30:00Z",
        "captured_by_username": "FlagHunter"
      }
    ]
  }
}
```

### Frontend (public/index.html)

Contas do tipo `company` veem o painel de controlo em vez do mapa do jogador:
- Estatisticas em tempo real (bandeiras ativas, capturas, moedas distribuidas, total de bandeiras).
- Tabela de capturas recentes com jogador, data e moedas.
- Formulario **Semear Campanha** com campos completos:
  - Titulo, tipo, coordenadas GPS, moedas, opcao premium.
  - **Premio fisico**: nome, descricao e valor estimado.
- Lista de todas as campanhas da empresa.

### Campos de Premio Fisico

Adicionadas 3 novas colunas a tabela `flags`:
- `physical_prize_name` (TEXT, nullable) — nome do premio fisico.
- `physical_prize_description` (TEXT, nullable) — descricao/condicoes do premio.
- `physical_prize_value` (TEXT, nullable) — valor estimado (ex: "10 EUR").

**Migracao necessaria (schema.sql ou manual):**
```sql
ALTER TABLE flags ADD COLUMN IF NOT EXISTS physical_prize_name TEXT;
ALTER TABLE flags ADD COLUMN IF NOT EXISTS physical_prize_description TEXT;
ALTER TABLE flags ADD COLUMN IF NOT EXISTS physical_prize_value TEXT;
```

### Notas Tecnicas

- A rota `POST /api/company/flags` foi atualizada para aceitar os campos de premio fisico.
- A rota `GET /api/company/flags` devolve os campos de premio fisico.
- O auto-login em `index.html` deteta o tipo de conta via `/api/auth/me` e mostra o painel correto.
- O teclado WASD e desativado quando o painel da empresa esta visivel.
- O painel empresa.html continua funcional como alternativa.

---

## Sistema de Pacotes de Bandeiras (Fase 1)

### 6 Tiers de Pacotes

| Tier | Nome | Bandeiras | Bingos | Raio | Dias | Preco |
|------|------|-----------|--------|------|------|-------|
| 1 | Starter | 1.000 | 0 | 0,25km | Sem prazo | Gratis |
| 2 | Local | 5.000 | 5 | 1km | 30 | 10 EUR + IVA |
| 3 | Regional | 10.000 | 10 | 5km | 60 | 15 EUR + IVA |
| 4 | Nacional | 25.000 | 25 | 20km | 90 | 20 EUR + IVA |
| 5 | Premium | 50.000 | 50 | 50km | 120 | 30 EUR + IVA |
| 6 | Enterprise | 100.000 | 100 | 100km | 250 | 50 EUR + IVA |

**Regras:**
- Tier 1 (Starter): gratuito, sem premios, sem bingos, sem prazo. Apenas dados da empresa nas bandeiras.
- Tiers 2-6: permitem premios reais. Cada premio = 20 bandeiras "prize". Restantes = "reward" (moedas/energia/skills).
- Todas as bandeiras dao skills, mesmo as de premio.
- Ao ativar pacote, todas as bandeiras sao geradas aleatoriamente dentro do raio definido pelo tier.
- Premio tem descricao livre e prazo de levantamento livre (apos expiracao do pacote).

### Rotas API

**`GET /api/company/tiers`** — publica, devolve os 6 tiers com detalhes.

**`POST /api/company/packages`** — cria pacote (rascunho). Requer JWT company.
- Body: `{ tier, center_latitude, center_longitude, prize_count?, prize_description?, prize_claim_deadline? }`
- Resposta: `{ success: true, package: { ... } }`

**`GET /api/company/packages`** — lista pacotes da empresa com contagem de bandeiras geradas/capturadas.

**`GET /api/company/packages/:id`** — detalhes de um pacote com estatisticas.

**`POST /api/company/packages/:id/activate`** — ativa pacote (gera todas as bandeiras no mapa).
- So funciona com pacotes em estado `draft`.
- Distribui bandeiras aleatoriamente dentro do raio do tier.
- Bandeiras prize: tipo "Prize", coin_value 5-15, energy_value 1-5.
- Bandeiras reward: tipos aleatorios (Coin, Energy_10, Energy_20, Skill).
- Resposta: `{ success: true, message: "...", flags_generated, prize_flags, reward_flags }`

### Nova Tabela: `flag_packages`

```sql
CREATE TABLE IF NOT EXISTS flag_packages (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    tier INTEGER NOT NULL CHECK (tier BETWEEN 1 AND 6),
    total_flags INTEGER NOT NULL,
    bingo_count INTEGER NOT NULL DEFAULT 0,
    radius_km NUMERIC(10,3) NOT NULL,
    duration_days INTEGER,
    price_cents INTEGER NOT NULL DEFAULT 0,
    prize_count INTEGER NOT NULL DEFAULT 0,
    prize_flags INTEGER NOT NULL DEFAULT 0,
    reward_flags INTEGER NOT NULL DEFAULT 0,
    prize_description TEXT,
    prize_claim_deadline TEXT,
    center_latitude NUMERIC(10,7),
    center_longitude NUMERIC(10,7),
    status VARCHAR(20) NOT NULL DEFAULT 'draft',
    activated_at TIMESTAMP,
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);
```

### Alteracoes na Tabela `flags`

```sql
ALTER TABLE flags ADD COLUMN IF NOT EXISTS package_id INTEGER;
ALTER TABLE flags ADD COLUMN IF NOT EXISTS flag_category VARCHAR(20) DEFAULT 'reward';
```

### Frontend

- Formulario **Criar Pacote de Bandeiras** no painel empresa:
  - Selector de tier com info dinamica.
  - Campos de coordenadas (centro).
  - Campos de premio (apenas para tiers 2-6): quantidade, descricao livre, prazo livre.
  - Calculadora em tempo real: X premios x 20 = Y prize + Z reward.
- Tabela **Pacotes da Empresa** com estado (rascunho/ativo/expirado) e botao Ativar.
- Confirmacao antes de ativar (acao irreversivel).

---

## Sistema de Bingos Flash (Fase 2)

### Conceito

Pacotes grandes (tiers 2-6) incluem bingos de bonus. Cada Bingo Flash:
- E agendado pela empresa com dia, hora, duracao (max 24h) e premio flash.
- Ao ativar, o bingo e colocado a **50m da loja** (posicao aleatoria dentro desse raio).
- Jogadores a **250m** da loja recebem alerta (simulacao via endpoint `nearby`).
- Jogadores a **50m** do bingo podem captura-lo.
- Se ninguem capturar no tempo definido, o bingo **expira** e e devolvido a empresa.

### Nova Tabela: `flash_bingos`

```sql
CREATE TABLE IF NOT EXISTS flash_bingos (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    package_id INTEGER,
    prize_name TEXT NOT NULL,
    scheduled_start TIMESTAMP NOT NULL,
    duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 1 AND 1440),
    store_latitude NUMERIC(10,7) NOT NULL,
    store_longitude NUMERIC(10,7) NOT NULL,
    bingo_latitude NUMERIC(10,7),
    bingo_longitude NUMERIC(10,7),
    status VARCHAR(20) NOT NULL DEFAULT 'scheduled',
    activated_at TIMESTAMP,
    expires_at TIMESTAMP,
    winner_player_id INTEGER,
    captured_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);
```

Estados: `scheduled` → `active` → `captured` ou `expired`.

### Rotas API

**`POST /api/company/bingos`** — criar/agendar bingo. Requer JWT company.
- Body: `{ package_id?, prize_name, scheduled_start, duration_minutes, store_latitude, store_longitude }`
- Valida slots de bingo disponiveis no pacote (se associado).
- Gera posicao do bingo a 50m da loja automaticamente.

**`GET /api/company/bingos`** — listar bingos da empresa com estado e vencedor.

**`POST /api/company/bingos/:id/activate`** — ativar bingo (muda para `active`, define `expires_at`).

**`GET /api/bingos/nearby?lat=X&lng=Y`** — simulacao de alerta para jogadores.
- Expira bingos vencidos automaticamente.
- Devolve bingos ativos a <=250m da loja do jogador.
- Para cada bingo: `alert: true`, `capturable: true/false` (<=50m do bingo), `time_remaining_s`.

**`POST /api/bingos/:id/capture`** — jogador captura bingo.
- Verifica distancia <=50m do bingo (haversine).
- Marca como `captured`, regista vencedor, +500 moedas.

**`POST /api/bingos/expire-check`** — endpoint de expiracao manual/cron.
- Marca bingos ativos vencidos como `expired` (devolvidos a empresa).

### Frontend

- Seccao **Gestao de Bingos Flash** no painel empresa:
  - Formulario de agendamento: pacote associado (dropdown), premio, data/hora, duracao, coordenadas da loja.
  - Tabela de bingos com estado (Agendado/Ativo/Capturado/Expirado), vencedor e botao Ativar.
  - Selector de pacote e populado dinamicamente com pacotes ativos que tenham bingos.

### Funcao auxiliar

`haversineMeters(lat1, lng1, lat2, lng2)` — calculo de distancia em metros entre dois pontos GPS (formula Haversine). Usada para validar proximidade na captura de bingos.
