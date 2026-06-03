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
