/**
 * ZAP-FLAGS 3.0 — Core game logic (pure functions extracted for testability).
 */

const WALK_STEP_METERS = 0.5;
const RUN_STEP_METERS = 1.5;
const GPS_METERS_TO_PERCENT = 0.1;
const GPS_BASE_LAT = 38.7223;
const GPS_BASE_LNG = -9.1393;

function createInitialState() {
  const now = Date.now();
  return {
    session: { type: null, id: null },
    players: [
      {
        id: 'player_demo',
        name: 'Avatar Demo',
        email: 'jogador@demo.pt',
        phone: '910000000',
        password: '123456',
        energy: 92,
        hunger: 80,
        mood: 76,
        coins: 1500,
        flags: 12,
        zap: 8,
        pr: 4,
        qrs: ['ZAP-CAF-2030'],
        position: { x: 50, y: 50 },
        createdAt: now
      },
      {
        id: 'player_norte',
        name: 'Jogador Norte',
        email: 'norte@demo.pt',
        phone: '920000000',
        password: '123456',
        energy: 88,
        hunger: 75,
        mood: 82,
        coins: 95,
        flags: 4,
        zap: 3,
        pr: 1,
        qrs: [],
        position: { x: 35, y: 35 },
        createdAt: now
      }
    ],
    companies: [
      { id: 'company_cafe', name: 'Café Central', nif: '123456789', email: 'empresa@demo.pt', password: '123456', pack: 'Básico', flags: 4200, status: 'Ativo', createdAt: now },
      { id: 'company_gym', name: 'Urban Gym', nif: '987654321', email: 'gym@demo.pt', password: '123456', pack: 'Pro', flags: 11800, status: 'Ativo', createdAt: now }
    ],
    qrs: [
      { id: 'qr_1', code: 'ZAP-CAF-2030', company: 'Café Central', value: '10% desconto', price: 24, type: 'QR', ownerId: null, forSale: true },
      { id: 'qr_2', code: 'FLAG-PREM-88A', company: 'Bandeira Premiada', value: 'Item negociável', price: 55, type: 'Premium Flag', ownerId: null, forSale: true },
      { id: 'qr_3', code: 'ZAP-GYM-4410', company: 'Urban Gym', value: 'Aula experimental', price: 40, type: 'QR', ownerId: null, forSale: true }
    ],
    flags: [
      { id: 'flag_1', type: 'ZAP', label: 'Flag ZAP Centro', x: 18, y: 26, reward: 3, active: true },
      { id: 'flag_2', type: 'PR', label: 'Flag PR Café', x: 72, y: 22, reward: 1, active: true },
      { id: 'flag_3', type: 'BINGO', label: 'Bingo Praça', x: 66, y: 68, reward: 25, active: true },
      { id: 'flag_4', type: 'ZAP', label: 'Flag ZAP Norte', x: 22, y: 72, reward: 3, active: true }
    ],
    bingos: [
      { id: 'bingo_1', name: 'Bingo Praça Verde', area: 'Centro', reward: 50, active: true }
    ],
    trades: [],
    audit: [
      { id: 'audit_1', at: now, text: 'Sistema ZAP-FLAGS 3.0 iniciado.' }
    ]
  };
}

function distanceBetween(a, b) {
  const dx = Number(a.x) - Number(b.x);
  const dy = Number(a.y) - Number(b.y);
  return Math.sqrt(dx * dx + dy * dy);
}

function clampStat(value) {
  return Math.max(0, Math.min(100, Number(value)));
}

function spendMovementStats(player) {
  player.energy = clampStat(Number(player.energy) - 1);
  player.hunger = clampStat(Number(player.hunger) - 1);
  player.mood = clampStat(Number(player.mood) - (player.hunger < 20 ? 2 : 0));
}

function canMove(player) {
  if (Number(player.energy) <= 0) {
    return { allowed: false, reason: 'energy' };
  }
  if (Number(player.hunger) <= 0) {
    return { allowed: false, reason: 'hunger' };
  }
  return { allowed: true, reason: null };
}

function uid(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
}

function escapeJs(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function ensurePlayerPosition(player) {
  if (!player.position) player.position = { x: 50, y: 50 };
  return player.position;
}

function playerPositionToLatLng(position) {
  return [
    GPS_BASE_LAT + ((50 - position.y) * 0.00001),
    GPS_BASE_LNG + ((position.x - 50) * 0.00001)
  ];
}

function formatTimeRemaining(expiresAt, now) {
  if (now === undefined) now = Date.now();
  const remaining = expiresAt - now;

  if (remaining <= 0) return 'Expirada';

  const hours = Math.floor(remaining / (1000 * 60 * 60));
  const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((remaining % (1000 * 60)) / 1000);

  if (hours > 0) {
    return `${hours}h ${minutes}min ${seconds}s`;
  } else if (minutes > 0) {
    return `${minutes}min ${seconds}s`;
  } else {
    return `${seconds}s`;
  }
}

function collectFlag(state, playerId, flagId) {
  const player = state.players.find(p => p.id === playerId);
  const flag = state.flags.find(item => item.id === flagId && item.active);
  if (!player || !flag) return { success: false, reason: 'unavailable' };
  const distance = distanceBetween(ensurePlayerPosition(player), flag);
  if (distance > 15) return { success: false, reason: 'too_far', distance: Math.round(distance) };
  flag.active = false;
  player.flags += 1;
  if (flag.type === 'ZAP') {
    player.zap += 1;
    player.energy = Math.min(100, player.energy + Number(flag.reward || 3));
  }
  if (flag.type === 'PR') {
    player.pr += 1;
    player.coins += 5;
  }
  if (flag.type === 'BINGO') {
    player.coins += Number(flag.reward || 25);
  }
  return { success: true, flagType: flag.type };
}

function acceptTrade(state, playerId, tradeId) {
  const trade = state.trades.find(item => item.id === tradeId && item.status === 'pending');
  if (!trade || trade.toId !== playerId) return { success: false, reason: 'unavailable' };
  const from = state.players.find(item => item.id === trade.fromId);
  const to = state.players.find(item => item.id === trade.toId);
  if (!from || !to) return { success: false, reason: 'player_not_found' };
  if (trade.qrCode && !from.qrs.includes(trade.qrCode)) return { success: false, reason: 'qr_unavailable' };
  if (trade.qrCode) {
    from.qrs = from.qrs.filter(code => code !== trade.qrCode);
    to.qrs.push(trade.qrCode);
  }
  to.coins += Number(trade.coins);
  trade.status = 'accepted';
  trade.resolvedAt = Date.now();
  return { success: true };
}

function rejectTrade(state, playerId, tradeId) {
  const trade = state.trades.find(item => item.id === tradeId && item.status === 'pending');
  if (!trade || trade.toId !== playerId) return { success: false, reason: 'unavailable' };
  const from = state.players.find(item => item.id === trade.fromId);
  if (from && trade.escrowCoins > 0) {
    from.coins += trade.escrowCoins;
  }
  trade.status = 'rejected';
  trade.resolvedAt = Date.now();
  return { success: true };
}

function cancelTrade(state, playerId, tradeId) {
  const trade = state.trades.find(item => item.id === tradeId && item.status === 'pending');
  if (!trade || trade.fromId !== playerId) return { success: false, reason: 'unavailable' };
  const player = state.players.find(p => p.id === playerId);
  if (player && trade.escrowCoins > 0) {
    player.coins += trade.escrowCoins;
  }
  trade.status = 'cancelled';
  trade.resolvedAt = Date.now();
  return { success: true };
}

function checkExpiredTrades(state, now) {
  if (now === undefined) now = Date.now();
  const expiredTrades = state.trades.filter(trade =>
    trade.status === 'pending' &&
    trade.expiresAt &&
    now > trade.expiresAt
  );

  expiredTrades.forEach(trade => {
    const from = state.players.find(item => item.id === trade.fromId);
    if (from && trade.escrowCoins > 0) {
      from.coins += trade.escrowCoins;
    }
    trade.status = 'expired';
    trade.resolvedAt = now;
  });

  return expiredTrades.length;
}

function movePlayerByKeyboard(state, playerId, dx, dy, running) {
  const player = state.players.find(p => p.id === playerId);
  if (!player) return { success: false, reason: 'no_player' };
  const moveCheck = canMove(player);
  if (!moveCheck.allowed) return { success: false, reason: moveCheck.reason };
  const position = ensurePlayerPosition(player);
  const speed = (running ? RUN_STEP_METERS : WALK_STEP_METERS) * GPS_METERS_TO_PERCENT;
  player.position = {
    x: position.x + (dx * speed),
    y: position.y + (dy * speed)
  };
  spendMovementStats(player);
  if (running) {
    spendMovementStats(player);
    spendMovementStats(player);
  }
  return { success: true, position: player.position };
}

function restPlayer(player) {
  player.energy = clampStat(Number(player.energy) + 20);
  player.mood = clampStat(Number(player.mood) + 5);
}

function feedPlayer(player) {
  if (Number(player.coins) < 10) return { success: false, reason: 'insufficient_coins' };
  player.coins -= 10;
  player.hunger = clampStat(Number(player.hunger) + 30);
  player.mood = clampStat(Number(player.mood) + 3);
  return { success: true };
}

function buyQr(state, playerId, qrId) {
  const player = state.players.find(p => p.id === playerId);
  const qr = state.qrs.find(item => item.id === qrId && item.forSale);
  if (!player || !qr) return { success: false, reason: 'unavailable' };
  if (player.coins < qr.price) return { success: false, reason: 'insufficient_coins' };
  player.coins -= qr.price;
  qr.ownerId = player.id;
  qr.forSale = false;
  player.qrs.push(qr.code);
  return { success: true, code: qr.code };
}

function addAudit(state, text) {
  state.audit.unshift({ id: 'audit_' + Date.now(), at: Date.now(), text });
  state.audit = state.audit.slice(0, 80);
}

module.exports = {
  WALK_STEP_METERS,
  RUN_STEP_METERS,
  GPS_METERS_TO_PERCENT,
  GPS_BASE_LAT,
  GPS_BASE_LNG,
  createInitialState,
  distanceBetween,
  clampStat,
  spendMovementStats,
  canMove,
  uid,
  escapeHtml,
  escapeJs,
  ensurePlayerPosition,
  playerPositionToLatLng,
  formatTimeRemaining,
  collectFlag,
  acceptTrade,
  rejectTrade,
  cancelTrade,
  checkExpiredTrades,
  movePlayerByKeyboard,
  restPlayer,
  feedPlayer,
  buyQr,
  addAudit
};
