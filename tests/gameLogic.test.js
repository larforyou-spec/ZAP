const {
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
} = require('../src/gameLogic');

// ─── createInitialState ─────────────────────────────────────────────────────

describe('createInitialState', () => {
  it('returns an object with expected top-level keys', () => {
    const state = createInitialState();
    expect(state).toHaveProperty('session');
    expect(state).toHaveProperty('players');
    expect(state).toHaveProperty('companies');
    expect(state).toHaveProperty('qrs');
    expect(state).toHaveProperty('flags');
    expect(state).toHaveProperty('bingos');
    expect(state).toHaveProperty('trades');
    expect(state).toHaveProperty('audit');
  });

  it('session starts with no active type or id', () => {
    const state = createInitialState();
    expect(state.session.type).toBeNull();
    expect(state.session.id).toBeNull();
  });

  it('has two default players', () => {
    const state = createInitialState();
    expect(state.players).toHaveLength(2);
    expect(state.players[0].id).toBe('player_demo');
    expect(state.players[1].id).toBe('player_norte');
  });

  it('has two default companies', () => {
    const state = createInitialState();
    expect(state.companies).toHaveLength(2);
  });

  it('has four default flags', () => {
    const state = createInitialState();
    expect(state.flags).toHaveLength(4);
    state.flags.forEach(flag => expect(flag.active).toBe(true));
  });

  it('trades array starts empty', () => {
    const state = createInitialState();
    expect(state.trades).toEqual([]);
  });
});

// ─── distanceBetween ────────────────────────────────────────────────────────

describe('distanceBetween', () => {
  it('returns 0 for same point', () => {
    expect(distanceBetween({ x: 10, y: 20 }, { x: 10, y: 20 })).toBe(0);
  });

  it('calculates correct Euclidean distance', () => {
    expect(distanceBetween({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it('handles string number inputs', () => {
    expect(distanceBetween({ x: '0', y: '0' }, { x: '3', y: '4' })).toBe(5);
  });

  it('handles negative coordinates', () => {
    const d = distanceBetween({ x: -3, y: -4 }, { x: 0, y: 0 });
    expect(d).toBe(5);
  });

  it('returns correct distance for diagonal movement', () => {
    const d = distanceBetween({ x: 0, y: 0 }, { x: 1, y: 1 });
    expect(d).toBeCloseTo(Math.SQRT2, 5);
  });
});

// ─── clampStat ──────────────────────────────────────────────────────────────

describe('clampStat', () => {
  it('clamps values above 100 to 100', () => {
    expect(clampStat(150)).toBe(100);
    expect(clampStat(101)).toBe(100);
  });

  it('clamps values below 0 to 0', () => {
    expect(clampStat(-5)).toBe(0);
    expect(clampStat(-100)).toBe(0);
  });

  it('leaves values within range unchanged', () => {
    expect(clampStat(50)).toBe(50);
    expect(clampStat(0)).toBe(0);
    expect(clampStat(100)).toBe(100);
  });

  it('handles string number input', () => {
    expect(clampStat('75')).toBe(75);
    expect(clampStat('200')).toBe(100);
  });

  it('returns NaN for NaN input', () => {
    expect(clampStat(NaN)).toBeNaN();
  });
});

// ─── spendMovementStats ─────────────────────────────────────────────────────

describe('spendMovementStats', () => {
  it('decreases energy and hunger by 1', () => {
    const player = { energy: 80, hunger: 70, mood: 60 };
    spendMovementStats(player);
    expect(player.energy).toBe(79);
    expect(player.hunger).toBe(69);
  });

  it('does not decrease mood when hunger >= 20', () => {
    const player = { energy: 80, hunger: 70, mood: 60 };
    spendMovementStats(player);
    expect(player.mood).toBe(60);
  });

  it('decreases mood by 2 when hunger < 20', () => {
    const player = { energy: 80, hunger: 15, mood: 60 };
    spendMovementStats(player);
    expect(player.mood).toBe(58);
  });

  it('does not decrease mood below 0', () => {
    const player = { energy: 80, hunger: 5, mood: 1 };
    spendMovementStats(player);
    expect(player.mood).toBe(0);
  });

  it('does not decrease energy below 0', () => {
    const player = { energy: 0, hunger: 50, mood: 50 };
    spendMovementStats(player);
    expect(player.energy).toBe(0);
  });

  it('does not decrease hunger below 0', () => {
    const player = { energy: 50, hunger: 0, mood: 50 };
    spendMovementStats(player);
    expect(player.hunger).toBe(0);
  });
});

// ─── canMove ────────────────────────────────────────────────────────────────

describe('canMove', () => {
  it('returns allowed:true when energy and hunger > 0', () => {
    const player = { energy: 50, hunger: 50 };
    expect(canMove(player)).toEqual({ allowed: true, reason: null });
  });

  it('returns allowed:false with reason energy when energy is 0', () => {
    const player = { energy: 0, hunger: 50 };
    expect(canMove(player)).toEqual({ allowed: false, reason: 'energy' });
  });

  it('returns allowed:false with reason hunger when hunger is 0', () => {
    const player = { energy: 50, hunger: 0 };
    expect(canMove(player)).toEqual({ allowed: false, reason: 'hunger' });
  });

  it('energy takes priority when both are 0', () => {
    const player = { energy: 0, hunger: 0 };
    expect(canMove(player).reason).toBe('energy');
  });
});

// ─── uid ────────────────────────────────────────────────────────────────────

describe('uid', () => {
  it('starts with the given prefix', () => {
    const id = uid('test');
    expect(id.startsWith('test_')).toBe(true);
  });

  it('generates unique ids on successive calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => uid('u')));
    expect(ids.size).toBe(100);
  });

  it('contains a timestamp-like segment', () => {
    const id = uid('x');
    const parts = id.split('_');
    expect(parts.length).toBeGreaterThanOrEqual(3);
    const timestamp = Number(parts[1]);
    expect(timestamp).toBeGreaterThan(1600000000000);
  });
});

// ─── escapeHtml ─────────────────────────────────────────────────────────────

describe('escapeHtml', () => {
  it('escapes & < > " and single quote', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#039;');
  });

  it('handles a complex string', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  it('handles null and undefined gracefully', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('handles numbers by converting to string', () => {
    expect(escapeHtml(42)).toBe('42');
  });

  it('returns plain text unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});

// ─── escapeJs ───────────────────────────────────────────────────────────────

describe('escapeJs', () => {
  it('escapes backslashes', () => {
    expect(escapeJs('path\\to\\file')).toBe('path\\\\to\\\\file');
  });

  it('escapes single quotes', () => {
    expect(escapeJs("it's")).toBe("it\\'s");
  });

  it('handles null and undefined', () => {
    expect(escapeJs(null)).toBe('');
    expect(escapeJs(undefined)).toBe('');
  });

  it('leaves safe strings unchanged', () => {
    expect(escapeJs('hello')).toBe('hello');
  });
});

// ─── ensurePlayerPosition ───────────────────────────────────────────────────

describe('ensurePlayerPosition', () => {
  it('returns existing position if present', () => {
    const player = { position: { x: 30, y: 40 } };
    expect(ensurePlayerPosition(player)).toEqual({ x: 30, y: 40 });
  });

  it('creates default position {x:50,y:50} if missing', () => {
    const player = {};
    const pos = ensurePlayerPosition(player);
    expect(pos).toEqual({ x: 50, y: 50 });
    expect(player.position).toEqual({ x: 50, y: 50 });
  });

  it('creates default position if position is null', () => {
    const player = { position: null };
    const pos = ensurePlayerPosition(player);
    expect(pos).toEqual({ x: 50, y: 50 });
  });
});

// ─── playerPositionToLatLng ─────────────────────────────────────────────────

describe('playerPositionToLatLng', () => {
  it('maps center position (50,50) to base coords', () => {
    const [lat, lng] = playerPositionToLatLng({ x: 50, y: 50 });
    expect(lat).toBeCloseTo(GPS_BASE_LAT, 5);
    expect(lng).toBeCloseTo(GPS_BASE_LNG, 5);
  });

  it('moving x right increases longitude', () => {
    const [, lng] = playerPositionToLatLng({ x: 60, y: 50 });
    expect(lng).toBeGreaterThan(GPS_BASE_LNG);
  });

  it('moving y up (lower value) increases latitude', () => {
    const [lat] = playerPositionToLatLng({ x: 50, y: 40 });
    expect(lat).toBeGreaterThan(GPS_BASE_LAT);
  });

  it('returns an array of [lat, lng]', () => {
    const result = playerPositionToLatLng({ x: 50, y: 50 });
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });
});

// ─── formatTimeRemaining ────────────────────────────────────────────────────

describe('formatTimeRemaining', () => {
  it('returns "Expirada" when time has passed', () => {
    const now = Date.now();
    expect(formatTimeRemaining(now - 1000, now)).toBe('Expirada');
  });

  it('formats hours, minutes, and seconds', () => {
    const now = 1000000;
    const expiresAt = now + (2 * 3600000) + (30 * 60000) + (15 * 1000);
    expect(formatTimeRemaining(expiresAt, now)).toBe('2h 30min 15s');
  });

  it('formats minutes and seconds when < 1 hour', () => {
    const now = 1000000;
    const expiresAt = now + (45 * 60000) + (10 * 1000);
    expect(formatTimeRemaining(expiresAt, now)).toBe('45min 10s');
  });

  it('formats only seconds when < 1 minute', () => {
    const now = 1000000;
    const expiresAt = now + (30 * 1000);
    expect(formatTimeRemaining(expiresAt, now)).toBe('30s');
  });

  it('returns "Expirada" for expiresAt === now', () => {
    const now = 1000000;
    expect(formatTimeRemaining(now, now)).toBe('Expirada');
  });
});

// ─── collectFlag ────────────────────────────────────────────────────────────

describe('collectFlag', () => {
  let state;

  beforeEach(() => {
    state = createInitialState();
    // position player near flag_1 (x:18, y:26) to be within range
    state.players[0].position = { x: 20, y: 26 };
  });

  it('collects a ZAP flag within range', () => {
    const result = collectFlag(state, 'player_demo', 'flag_1');
    expect(result.success).toBe(true);
    expect(result.flagType).toBe('ZAP');
    expect(state.players[0].flags).toBe(13);
    expect(state.players[0].zap).toBe(9);
  });

  it('fails when player is too far from flag', () => {
    state.players[0].position = { x: 80, y: 80 };
    const result = collectFlag(state, 'player_demo', 'flag_1');
    expect(result.success).toBe(false);
    expect(result.reason).toBe('too_far');
  });

  it('fails for inactive/non-existent flag', () => {
    const result = collectFlag(state, 'player_demo', 'nonexistent');
    expect(result.success).toBe(false);
    expect(result.reason).toBe('unavailable');
  });

  it('deactivates flag after collection', () => {
    collectFlag(state, 'player_demo', 'flag_1');
    const flag = state.flags.find(f => f.id === 'flag_1');
    expect(flag.active).toBe(false);
  });

  it('adds energy reward for ZAP type', () => {
    state.players[0].energy = 90;
    collectFlag(state, 'player_demo', 'flag_1');
    expect(state.players[0].energy).toBe(93); // +3 reward
  });

  it('adds coins for BINGO type', () => {
    // Position player near flag_3 (BINGO at x:66, y:68)
    state.players[0].position = { x: 66, y: 68 };
    const initialCoins = state.players[0].coins;
    collectFlag(state, 'player_demo', 'flag_3');
    expect(state.players[0].coins).toBe(initialCoins + 25);
  });

  it('adds coins and PR count for PR type', () => {
    // Position player near flag_2 (PR at x:72, y:22)
    state.players[0].position = { x: 72, y: 22 };
    const initialCoins = state.players[0].coins;
    const initialPr = state.players[0].pr;
    collectFlag(state, 'player_demo', 'flag_2');
    expect(state.players[0].coins).toBe(initialCoins + 5);
    expect(state.players[0].pr).toBe(initialPr + 1);
  });
});

// ─── Trade functions ────────────────────────────────────────────────────────

describe('acceptTrade', () => {
  let state;

  beforeEach(() => {
    state = createInitialState();
    state.trades.push({
      id: 'trade_1',
      fromId: 'player_norte',
      toId: 'player_demo',
      qrCode: null,
      coins: 20,
      status: 'pending',
      escrowCoins: 20,
      createdAt: Date.now(),
      expiresAt: Date.now() + 86400000
    });
  });

  it('accepts a valid trade and transfers coins', () => {
    const initialCoins = state.players[0].coins;
    const result = acceptTrade(state, 'player_demo', 'trade_1');
    expect(result.success).toBe(true);
    expect(state.players[0].coins).toBe(initialCoins + 20);
    expect(state.trades[0].status).toBe('accepted');
  });

  it('fails for wrong recipient', () => {
    const result = acceptTrade(state, 'player_norte', 'trade_1');
    expect(result.success).toBe(false);
  });

  it('fails for non-existent trade', () => {
    const result = acceptTrade(state, 'player_demo', 'fake_trade');
    expect(result.success).toBe(false);
  });

  it('transfers QR code on acceptance', () => {
    state.players[1].qrs = ['MY-QR-CODE'];
    state.trades[0].qrCode = 'MY-QR-CODE';
    acceptTrade(state, 'player_demo', 'trade_1');
    expect(state.players[1].qrs).not.toContain('MY-QR-CODE');
    expect(state.players[0].qrs).toContain('MY-QR-CODE');
  });
});

describe('rejectTrade', () => {
  let state;

  beforeEach(() => {
    state = createInitialState();
    state.players[1].coins = 80; // after escrow deduction
    state.trades.push({
      id: 'trade_1',
      fromId: 'player_norte',
      toId: 'player_demo',
      qrCode: null,
      coins: 20,
      status: 'pending',
      escrowCoins: 20,
      createdAt: Date.now(),
      expiresAt: Date.now() + 86400000
    });
  });

  it('rejects trade and returns escrow coins to sender', () => {
    const result = rejectTrade(state, 'player_demo', 'trade_1');
    expect(result.success).toBe(true);
    expect(state.trades[0].status).toBe('rejected');
    expect(state.players[1].coins).toBe(100); // 80 + 20 escrow
  });

  it('fails for wrong player', () => {
    const result = rejectTrade(state, 'player_norte', 'trade_1');
    expect(result.success).toBe(false);
  });
});

describe('cancelTrade', () => {
  let state;

  beforeEach(() => {
    state = createInitialState();
    state.players[1].coins = 75; // after escrow
    state.trades.push({
      id: 'trade_1',
      fromId: 'player_norte',
      toId: 'player_demo',
      qrCode: null,
      coins: 20,
      status: 'pending',
      escrowCoins: 20,
      createdAt: Date.now(),
      expiresAt: Date.now() + 86400000
    });
  });

  it('cancels trade and returns escrow to sender', () => {
    const result = cancelTrade(state, 'player_norte', 'trade_1');
    expect(result.success).toBe(true);
    expect(state.trades[0].status).toBe('cancelled');
    expect(state.players[1].coins).toBe(95); // 75 + 20
  });

  it('fails for non-sender', () => {
    const result = cancelTrade(state, 'player_demo', 'trade_1');
    expect(result.success).toBe(false);
  });
});

describe('checkExpiredTrades', () => {
  let state;

  beforeEach(() => {
    state = createInitialState();
    state.players[1].coins = 75;
  });

  it('expires trades past their expiresAt and returns escrow', () => {
    const past = Date.now() - 1000;
    state.trades.push({
      id: 'trade_exp',
      fromId: 'player_norte',
      toId: 'player_demo',
      coins: 20,
      status: 'pending',
      escrowCoins: 20,
      expiresAt: past,
      createdAt: past - 86400000
    });
    const count = checkExpiredTrades(state, Date.now());
    expect(count).toBe(1);
    expect(state.trades[0].status).toBe('expired');
    expect(state.players[1].coins).toBe(95);
  });

  it('does not expire trades that are still within time', () => {
    const future = Date.now() + 86400000;
    state.trades.push({
      id: 'trade_active',
      fromId: 'player_norte',
      toId: 'player_demo',
      coins: 10,
      status: 'pending',
      escrowCoins: 10,
      expiresAt: future,
      createdAt: Date.now()
    });
    const count = checkExpiredTrades(state, Date.now());
    expect(count).toBe(0);
    expect(state.trades[0].status).toBe('pending');
  });

  it('ignores non-pending trades', () => {
    const past = Date.now() - 1000;
    state.trades.push({
      id: 'trade_done',
      fromId: 'player_norte',
      toId: 'player_demo',
      coins: 10,
      status: 'accepted',
      escrowCoins: 10,
      expiresAt: past,
      createdAt: past - 86400000
    });
    const count = checkExpiredTrades(state, Date.now());
    expect(count).toBe(0);
  });
});

// ─── movePlayerByKeyboard ───────────────────────────────────────────────────

describe('movePlayerByKeyboard', () => {
  let state;

  beforeEach(() => {
    state = createInitialState();
    state.players[0].position = { x: 50, y: 50 };
    state.players[0].energy = 80;
    state.players[0].hunger = 70;
    state.players[0].mood = 60;
  });

  it('moves player right when walking', () => {
    const result = movePlayerByKeyboard(state, 'player_demo', 1, 0, false);
    expect(result.success).toBe(true);
    const expectedX = 50 + (WALK_STEP_METERS * GPS_METERS_TO_PERCENT);
    expect(result.position.x).toBeCloseTo(expectedX, 5);
    expect(result.position.y).toBe(50);
  });

  it('moves player faster when running', () => {
    const result = movePlayerByKeyboard(state, 'player_demo', 1, 0, true);
    expect(result.success).toBe(true);
    const expectedX = 50 + (RUN_STEP_METERS * GPS_METERS_TO_PERCENT);
    expect(result.position.x).toBeCloseTo(expectedX, 5);
  });

  it('spends more movement stats when running (3x)', () => {
    const initial = { ...state.players[0] };
    movePlayerByKeyboard(state, 'player_demo', 1, 0, true);
    // Running calls spendMovementStats 3 times total
    expect(state.players[0].energy).toBe(initial.energy - 3);
  });

  it('fails if player has no energy', () => {
    state.players[0].energy = 0;
    const result = movePlayerByKeyboard(state, 'player_demo', 1, 0, false);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('energy');
  });

  it('fails for non-existent player', () => {
    const result = movePlayerByKeyboard(state, 'fake_player', 1, 0, false);
    expect(result.success).toBe(false);
  });
});

// ─── restPlayer ─────────────────────────────────────────────────────────────

describe('restPlayer', () => {
  it('increases energy by 20 and mood by 5', () => {
    const player = { energy: 60, mood: 50 };
    restPlayer(player);
    expect(player.energy).toBe(80);
    expect(player.mood).toBe(55);
  });

  it('does not exceed 100 for energy', () => {
    const player = { energy: 95, mood: 50 };
    restPlayer(player);
    expect(player.energy).toBe(100);
  });

  it('does not exceed 100 for mood', () => {
    const player = { energy: 50, mood: 98 };
    restPlayer(player);
    expect(player.mood).toBe(100);
  });
});

// ─── feedPlayer ─────────────────────────────────────────────────────────────

describe('feedPlayer', () => {
  it('costs 10 coins and increases hunger by 30, mood by 3', () => {
    const player = { coins: 50, hunger: 40, mood: 50 };
    const result = feedPlayer(player);
    expect(result.success).toBe(true);
    expect(player.coins).toBe(40);
    expect(player.hunger).toBe(70);
    expect(player.mood).toBe(53);
  });

  it('fails if player has fewer than 10 coins', () => {
    const player = { coins: 5, hunger: 40, mood: 50 };
    const result = feedPlayer(player);
    expect(result.success).toBe(false);
    expect(player.coins).toBe(5);
  });

  it('clamps hunger at 100', () => {
    const player = { coins: 50, hunger: 85, mood: 50 };
    feedPlayer(player);
    expect(player.hunger).toBe(100);
  });
});

// ─── buyQr ──────────────────────────────────────────────────────────────────

describe('buyQr', () => {
  let state;

  beforeEach(() => {
    state = createInitialState();
  });

  it('buys a QR that is for sale', () => {
    const initialCoins = state.players[0].coins;
    const result = buyQr(state, 'player_demo', 'qr_1');
    expect(result.success).toBe(true);
    expect(state.players[0].coins).toBe(initialCoins - 24);
    expect(state.players[0].qrs).toContain('ZAP-CAF-2030');
  });

  it('marks QR as not for sale after purchase', () => {
    buyQr(state, 'player_demo', 'qr_1');
    const qr = state.qrs.find(q => q.id === 'qr_1');
    expect(qr.forSale).toBe(false);
    expect(qr.ownerId).toBe('player_demo');
  });

  it('fails if player has insufficient coins', () => {
    state.players[0].coins = 1;
    const result = buyQr(state, 'player_demo', 'qr_2');
    expect(result.success).toBe(false);
    expect(result.reason).toBe('insufficient_coins');
  });

  it('fails for non-existent QR', () => {
    const result = buyQr(state, 'player_demo', 'qr_fake');
    expect(result.success).toBe(false);
  });

  it('fails for QR not for sale', () => {
    state.qrs[0].forSale = false;
    const result = buyQr(state, 'player_demo', 'qr_1');
    expect(result.success).toBe(false);
  });
});

// ─── addAudit ───────────────────────────────────────────────────────────────

describe('addAudit', () => {
  it('adds an audit entry at the beginning of the list', () => {
    const state = createInitialState();
    addAudit(state, 'Test entry');
    expect(state.audit[0].text).toBe('Test entry');
  });

  it('keeps maximum 80 audit entries', () => {
    const state = createInitialState();
    for (let i = 0; i < 100; i++) {
      addAudit(state, `Entry ${i}`);
    }
    expect(state.audit.length).toBe(80);
  });

  it('most recent entry is first', () => {
    const state = createInitialState();
    addAudit(state, 'First');
    addAudit(state, 'Second');
    expect(state.audit[0].text).toBe('Second');
    expect(state.audit[1].text).toBe('First');
  });
});
