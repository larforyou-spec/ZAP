require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('./db');
const verifyJWT = require('./middleware/auth');
const rules = require('./game-rules');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-this-secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

const PACKAGE_TIERS = {
    1: { name: 'Starter',     flags: 1000,   bingos: 0,   radius_km: 0.25,  duration_days: null, price_cents: 0,    has_prizes: false },
    2: { name: 'Local',       flags: 5000,   bingos: 5,   radius_km: 1,     duration_days: 30,   price_cents: 1000, has_prizes: true  },
    3: { name: 'Regional',    flags: 10000,  bingos: 10,  radius_km: 5,     duration_days: 60,   price_cents: 1500, has_prizes: true  },
    4: { name: 'Nacional',    flags: 25000,  bingos: 25,  radius_km: 20,    duration_days: 90,   price_cents: 2000, has_prizes: true  },
    5: { name: 'Premium',     flags: 50000,  bingos: 50,  radius_km: 50,    duration_days: 120,  price_cents: 3000, has_prizes: true  },
    6: { name: 'Enterprise',  flags: 100000, bingos: 100, radius_km: 100,   duration_days: 250,  price_cents: 5000, has_prizes: true  }
};

function randomPointInRadius(centerLat, centerLng, radiusKm) {
    const angle = Math.random() * 2 * Math.PI;
    const dist = radiusKm * Math.sqrt(Math.random());
    const dLat = dist / 111.32;
    const dLng = dist / (111.32 * Math.cos(centerLat * Math.PI / 180));
    return {
        latitude: centerLat + dLat * Math.cos(angle),
        longitude: centerLng + dLng * Math.sin(angle)
    };
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(morgan('combined'));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function normalizePlayer(row) {
    if (!row) return null;

    return {
        ...row,
        current_energy: Number(row.current_energy),
        capture_radius: rules.getCaptureRadius(Number(row.skill_level || 0))
    };
}

function signToken(user, player) {
    return jwt.sign({
        user_id: user.id,
        player_id: player?.id || null,
        account_type: user.account_type,
        email: user.email
    }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function getAuthRedirectUrl(accountType) {
    return accountType === 'company' ? '/empresa.html' : '/index.html';
}

async function resolvePlayerId(req) {
    if (req.user?.playerId) return Number(req.user.playerId);
    if (req.params.id === 'me') return 1;
    return Number(req.params.id || req.body.player_id || req.query.player_id || 1);
}

async function getPlayer(playerId, client = db) {
    const result = await client.query(`
        SELECT p.*, u.email, u.account_type, u.display_name
        FROM players p
        JOIN users u ON u.id = p.user_id
        WHERE p.id = $1
    `, [playerId]);
    return normalizePlayer(result.rows[0]);
}

async function getPlayerByUserId(userId, client = db) {
    const result = await client.query(`
        SELECT p.*, u.email, u.account_type, u.display_name
        FROM players p
        JOIN users u ON u.id = p.user_id
        WHERE p.user_id = $1
    `, [userId]);
    return normalizePlayer(result.rows[0]);
}

async function updatePlayer(playerId, patch, client = db) {
    const keys = Object.keys(patch);
    const values = Object.values(patch);

    if (!keys.length) return getPlayer(playerId, client);

    const assignments = keys.map((key, index) => `${key} = $${index + 2}`).join(', ');
    const result = await client.query(
        `UPDATE players SET ${assignments}, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [playerId, ...values]
    );

    return normalizePlayer(result.rows[0]);
}

async function captureFlagsForPlayer(player, latitude, longitude, client = db) {
    const flagsResult = await client.query(`
        SELECT * FROM flags
        WHERE captured_at IS NULL
        AND (premium_expires_at IS NULL OR premium_expires_at > NOW())
    `);

    const captureRadius = rules.getCaptureRadius(player.skill_level);
    const capturedFlags = [];
    let flagsTotal = Number(player.flags_caught_total || 0);
    let coinWallet = Number(player.coin_wallet || 0);
    let energy = Number(player.current_energy || 0);
    let skillLevel = Number(player.skill_level || 0);

    for (const flag of flagsResult.rows) {
        const flagDistance = rules.calculateDistance(latitude, longitude, flag.latitude, flag.longitude);
        if (flagDistance > captureRadius) continue;

        const captureResult = await client.query(
            'UPDATE flags SET captured_at = NOW(), captured_by = $1 WHERE id = $2 AND captured_at IS NULL',
            [player.id, flag.id]
        );
        if (captureResult.rowCount === 0) continue;

        await client.query(
            'INSERT INTO capture_history (player_id, flag_id, coins_earned) VALUES ($1, $2, $3)',
            [player.user_id, flag.id, Number(flag.coin_value || 0)]
        );

        flagsTotal += 1;
        coinWallet += Number(flag.coin_value || 0);
        energy = Math.min(100, energy + Number(flag.energy_value || 0));
        const newLevel = rules.calculateSkillLevel(flagsTotal, skillLevel);
        const levelUp = newLevel > skillLevel;
        skillLevel = newLevel;

        capturedFlags.push({
            flag,
            rewards: {
                coins: flag.coin_value || 0,
                energy: flag.energy_value || 0,
                type: flag.type
            },
            new_skill_level: newLevel,
            level_up: levelUp,
            capture_distance: flagDistance
        });
    }

    const updatedPlayer = await updatePlayer(player.id, {
        flags_caught_total: flagsTotal,
        coin_wallet: coinWallet,
        current_energy: energy,
        skill_level: skillLevel
    }, client);

    return { player: updatedPlayer, capturedFlags };
}

async function initializeDatabase() {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await db.query(schema);

    const countResult = await db.query('SELECT COUNT(*)::int AS count FROM users');
    if (countResult.rows[0].count > 0) {
        console.log('? Database ready');
        return;
    }

    await db.transaction(async (client) => {
        const passwordHash = await bcrypt.hash('demo123', 12);
        const demoUsers = [
            ['demo@larforyou.pt', passwordHash, 'player', 'DemoPlayer'],
            ['flaghunter@larforyou.pt', passwordHash, 'player', 'FlagHunter'],
            ['lisbonrunner@larforyou.pt', passwordHash, 'player', 'LisbonRunner']
        ];

        for (const user of demoUsers) {
            const userResult = await client.query(
                'INSERT INTO users (email, password_hash, account_type, display_name) VALUES ($1, $2, $3, $4) RETURNING *',
                user
            );
            const createdUser = userResult.rows[0];
            const stats = createdUser.display_name === 'FlagHunter'
                ? [7, 1040, 78, 320, 38.7215, -9.1387]
                : createdUser.display_name === 'LisbonRunner'
                    ? [4, 760, 64, 185, 38.7240, -9.1402]
                    : [0, 0, 100, 500, 38.7223, -9.1393];

            const playerResult = await client.query(`
                INSERT INTO players
                (user_id, username, skill_level, flags_caught_total, current_energy, coin_wallet, last_latitude, last_longitude, virtual_latitude, virtual_longitude)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7, $8)
                RETURNING *
            `, [createdUser.id, createdUser.display_name, ...stats]);

            await client.query('INSERT INTO player_settings (player_id) VALUES ($1)', [playerResult.rows[0].id]);
        }

        const companyResult = await client.query(
            'INSERT INTO users (email, password_hash, account_type, display_name) VALUES ($1, $2, $3, $4) RETURNING *',
            ['empresa@larforyou.pt', passwordHash, 'company', 'Larforyou Empresas']
        );
        const companyId = companyResult.rows[0].id;

        await client.query(`
            INSERT INTO flags (company_id, type, is_premium, latitude, longitude, coin_value, energy_value, premium_expires_at) VALUES
            ($1, 'Coin', false, 38.7225, -9.1395, 25, 0, NULL),
            ($1, 'Energy_10', false, 38.7220, -9.1390, 0, 10, NULL),
            ($1, 'Premium_PEC', true, 38.7230, -9.1400, 100, 0, NOW() + INTERVAL '15 days'),
            ($1, 'Energy_20', false, 38.7228, -9.1388, 0, 20, NULL),
            ($1, 'Bingo', true, 38.7218, -9.1398, 500, 0, NOW() + INTERVAL '15 days')
        `, [companyId]);

        const cafeItem = await client.query(`
            INSERT INTO items (type, company_id, company_name, name, qr_code, qr_status, estimated_value)
            VALUES ('premium_flag', 1, 'Larforyou Café Lisboa', 'Café grátis', 'LARF-CAFE-001', 'available', 75)
            RETURNING *
        `);
        const techItem = await client.query(`
            INSERT INTO items (type, company_id, company_name, name, qr_code, qr_status, estimated_value)
            VALUES ('premium_flag', 2, 'Arena Tech Store', 'Desconto 10%', NULL, 'available', 0)
            RETURNING *
        `);
        await client.query('INSERT INTO player_items (player_id, item_id, quantity) VALUES (1, $1, 1), (1, $2, 1)', [cafeItem.rows[0].id, techItem.rows[0].id]);

        await client.query(`
            INSERT INTO market_listings (seller_id, item_type, item_name, qr_code, price, status) VALUES
            (2, 'QR', 'Desconto 20% Arena Tech', 'ARENA-TECH-020', 120, 'active'),
            (3, 'Premium Flag', 'Flag Premium Lisboa', NULL, 250, 'active')
        `);

        await client.query(`
            INSERT INTO trade_offers (from_player_id, to_player_id, offered_item, requested_item)
            VALUES (2, 1, 'QR Desconto 20%', '80 moedas')
        `);
    });

    console.log('?? PostgreSQL database initialized with demo data');
}

app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, display_name, name, account_type = 'player' } = req.body;

        if (!email || !password || !(display_name || name)) {
            return res.status(400).json({ error: 'Email, password and display name are required' });
        }

        if (!['player', 'company'].includes(account_type)) {
            return res.status(400).json({ error: 'Invalid account type' });
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const result = await db.transaction(async (client) => {
            const userResult = await client.query(
                'INSERT INTO users (email, password_hash, account_type, display_name) VALUES ($1, $2, $3, $4) RETURNING id, email, account_type, display_name, created_at',
                [String(email).toLowerCase(), passwordHash, account_type, display_name || name]
            );
            const user = userResult.rows[0];
            let player = null;

            if (account_type === 'player') {
                const playerResult = await client.query(
                    'INSERT INTO players (user_id, username) VALUES ($1, $2) RETURNING *',
                    [user.id, user.display_name]
                );
                player = normalizePlayer(playerResult.rows[0]);
                await client.query('INSERT INTO player_settings (player_id) VALUES ($1)', [player.id]);
            }

            return { user, player };
        });

        res.json({ success: true, token: signToken(result.user, result.player), redirect_url: getAuthRedirectUrl(result.user.account_type), ...result });
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'Email already exists' });
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const identifier = String(email || '').trim();
        const userResult = await db.query(
            'SELECT * FROM users WHERE LOWER(email) = LOWER($1) OR LOWER(display_name) = LOWER($1)',
            [identifier]
        );
        const user = userResult.rows[0];

        if (!user || !(await bcrypt.compare(password || '', user.password_hash))) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const player = user.account_type === 'player' ? await getPlayerByUserId(user.id) : null;
        delete user.password_hash;
        res.json({ success: true, token: signToken(user, player), redirect_url: getAuthRedirectUrl(user.account_type), user, player });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/auth/me', verifyJWT, async (req, res) => {
    try {
        const userResult = await db.query('SELECT id, email, account_type, display_name, created_at FROM users WHERE id = $1', [req.user.userId]);
        const player = req.user.playerId ? await getPlayer(req.user.playerId) : null;
        res.json({ user: userResult.rows[0], player });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/health', async (req, res) => {
    try {
        const players = await db.query('SELECT COUNT(*)::int AS count FROM players');
        const flags = await db.query('SELECT COUNT(*)::int AS count FROM flags WHERE captured_at IS NULL');
        res.json({ status: 'ok', message: 'Larforyou Arena API is running', timestamp: new Date().toISOString(), players: players.rows[0].count, flags: flags.rows[0].count });
    } catch (error) {
        res.status(500).json({ status: 'error', error: error.message });
    }
});

app.get('/api/player/me', verifyJWT, async (req, res) => {
    try {
        const player = await getPlayer(await resolvePlayerId(req));
        if (!player) return res.status(404).json({ error: 'Player not found' });
        res.json(player);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/player/:id', async (req, res) => {
    try {
        const player = await getPlayer(await resolvePlayerId(req));
        if (!player) return res.status(404).json({ error: 'Player not found' });
        res.json(player);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/player/me/location', verifyJWT, async (req, res) => {
    try {
        const playerId = await resolvePlayerId(req);
        const { latitude, longitude, is_virtual } = req.body;
        const result = await db.transaction(async (client) => {
            const player = await getPlayer(playerId, client);
            if (!player) throw new Error('Player not found');

            const oldLat = is_virtual ? player.virtual_latitude : player.last_latitude;
            const oldLng = is_virtual ? player.virtual_longitude : player.last_longitude;
            const distance = rules.calculateDistance(oldLat, oldLng, latitude, longitude);
            const energyCost = rules.calculateEnergyCost(distance, Boolean(is_virtual));

            if (player.current_energy < energyCost) {
                const error = new Error('Insufficient energy for this movement');
                error.status = 400;
                throw error;
            }

            let updatedPlayer = await updatePlayer(playerId, {
                last_latitude: is_virtual ? player.last_latitude : latitude,
                last_longitude: is_virtual ? player.last_longitude : longitude,
                virtual_latitude: is_virtual ? latitude : player.virtual_latitude,
                virtual_longitude: is_virtual ? longitude : player.virtual_longitude,
                is_virtual_mode: Boolean(is_virtual),
                current_energy: player.current_energy - energyCost,
                last_location_update: new Date()
            }, client);

            const captureResult = await captureFlagsForPlayer(updatedPlayer, latitude, longitude, client);
            updatedPlayer = captureResult.player;

            return { updatedPlayer, distance, energyCost, capturedFlags: captureResult.capturedFlags };
        });

        res.json({ success: true, player: result.updatedPlayer, distance_moved: result.distance, energy_spent: result.energyCost, flags_captured: result.capturedFlags, message: `Moved ${result.distance.toFixed(2)}m, spent ${result.energyCost.toFixed(1)}% energy` });
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message });
    }
});

app.put('/api/player/:id/location', async (req, res) => {
    try {
        const playerId = await resolvePlayerId(req);
        const { latitude, longitude, is_virtual } = req.body;
        const result = await db.transaction(async (client) => {
            const player = await getPlayer(playerId, client);
            if (!player) throw new Error('Player not found');

            const oldLat = is_virtual ? player.virtual_latitude : player.last_latitude;
            const oldLng = is_virtual ? player.virtual_longitude : player.last_longitude;
            const distance = rules.calculateDistance(oldLat, oldLng, latitude, longitude);
            const energyCost = rules.calculateEnergyCost(distance, Boolean(is_virtual));

            if (player.current_energy < energyCost) {
                const error = new Error('Insufficient energy for this movement');
                error.status = 400;
                throw error;
            }

            let updatedPlayer = await updatePlayer(playerId, {
                last_latitude: is_virtual ? player.last_latitude : latitude,
                last_longitude: is_virtual ? player.last_longitude : longitude,
                virtual_latitude: is_virtual ? latitude : player.virtual_latitude,
                virtual_longitude: is_virtual ? longitude : player.virtual_longitude,
                is_virtual_mode: Boolean(is_virtual),
                current_energy: player.current_energy - energyCost,
                last_location_update: new Date()
            }, client);

            const captureResult = await captureFlagsForPlayer(updatedPlayer, latitude, longitude, client);
            updatedPlayer = captureResult.player;

            return { updatedPlayer, distance, energyCost, capturedFlags: captureResult.capturedFlags };
        });

        res.json({ success: true, player: result.updatedPlayer, distance_moved: result.distance, energy_spent: result.energyCost, flags_captured: result.capturedFlags, message: `Moved ${result.distance.toFixed(2)}m, spent ${result.energyCost.toFixed(1)}% energy` });
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message });
    }
});

app.post('/api/player/me/virtual-move', verifyJWT, async (req, res) => {
    if (req.user.accountType !== 'player') {
        return res.status(403).json({ error: 'Apenas contas do tipo Jogador podem mover-se.' });
    }

    try {
        const playerId = req.user.playerId;
        const { direction } = req.body;
        const result = await db.transaction(async (client) => {
            const player = await getPlayer(playerId, client);
            if (!player) throw new Error('Player not found');
            if (!player.is_virtual_mode) {
                const error = new Error('Virtual mode is not enabled');
                error.status = 400;
                throw error;
            }

            const settingsResult = await client.query('SELECT virtual_step_size FROM player_settings WHERE player_id = $1', [playerId]);
            const configuredStepSize = Number(settingsResult.rows[0]?.virtual_step_size || 0.5);
            const stepSize = Math.min(Math.max(configuredStepSize, 0.1), 0.5);
            const currentLat = player.virtual_latitude || player.last_latitude;
            const currentLng = player.virtual_longitude || player.last_longitude;
            let newLat = currentLat;
            let newLng = currentLng;
            const latStep = stepSize / 111000;
            const lngStep = stepSize / (111000 * Math.cos(currentLat * Math.PI / 180));

            switch (String(direction || '').toLowerCase()) {
                case 'n':
                case 'up':
                    newLat += latStep;
                    break;
                case 's':
                case 'down':
                    newLat -= latStep;
                    break;
                case 'w':
                case 'left':
                case 'a':
                    newLng -= lngStep;
                    break;
                case 'e':
                case 'right':
                case 'd':
                    newLng += lngStep;
                    break;
                default: {
                    const error = new Error('Invalid direction');
                    error.status = 400;
                    throw error;
                }
            }

            const energyCost = stepSize * 0.05;
            if (player.current_energy < energyCost) {
                const error = new Error(`Insufficient energy. Need ${energyCost.toFixed(1)}%, have ${player.current_energy.toFixed(1)}%`);
                error.status = 400;
                throw error;
            }

            let updatedPlayer = await updatePlayer(playerId, {
                virtual_latitude: newLat,
                virtual_longitude: newLng,
                current_energy: player.current_energy - energyCost,
                last_location_update: new Date()
            }, client);
            const captureResult = await captureFlagsForPlayer(updatedPlayer, newLat, newLng, client);

            return { currentLat, currentLng, newLat, newLng, stepSize, energyCost, player: captureResult.player, capturedFlags: captureResult.capturedFlags };
        });

        res.json({
            success: true,
            latitude: result.newLat,
            longitude: result.newLng,
            energy: result.player.current_energy,
            player: result.player,
            old_position: { latitude: result.currentLat, longitude: result.currentLng },
            new_position: { latitude: result.newLat, longitude: result.newLng },
            distance_moved: result.stepSize,
            energy_spent: result.energyCost,
            remaining_energy: result.player.current_energy,
            flags_captured: result.capturedFlags,
            message: 'Movimento processado com sucesso.'
        });
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message });
    }
});

app.post('/api/player/me/recover-energy', verifyJWT, async (req, res) => {
    try {
        const player = await getPlayer(await resolvePlayerId(req));
        if (!player) return res.status(404).json({ error: 'Player not found' });

        const now = new Date();
        const lastRecovery = new Date(player.last_energy_recovery || now);
        const minutesSinceRecovery = (now - lastRecovery) / (1000 * 60);

        if (minutesSinceRecovery < 15) {
            return res.status(400).json({ error: `Energy recovery available in ${(15 - minutesSinceRecovery).toFixed(1)} minutes`, minutes_until_recovery: 15 - minutesSinceRecovery });
        }

        const previousEnergy = Number(player.current_energy);
        const recovery = rules.applyPassiveRecovery(previousEnergy, player.last_energy_recovery, now);
        const newEnergy = recovery.current_energy;
        const updatedPlayer = await updatePlayer(player.id, { current_energy: newEnergy, last_energy_recovery: now });
        res.json({ success: true, energy_recovered: newEnergy - previousEnergy, new_energy: updatedPlayer.current_energy, previous_energy: previousEnergy, message: `Recovered ${newEnergy - previousEnergy}% energy. Current: ${newEnergy}%` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/flags/nearby', async (req, res) => {
    try {
        const { latitude, longitude, radius = 100 } = req.query;
        const flagsResult = await db.query(`
            SELECT * FROM flags
            WHERE captured_at IS NULL
            AND (premium_expires_at IS NULL OR premium_expires_at > NOW())
        `);
        const nearbyFlags = flagsResult.rows.map(flag => ({
            ...flag,
            distance_meters: rules.calculateDistance(Number(latitude), Number(longitude), flag.latitude, flag.longitude)
        })).filter(flag => flag.distance_meters <= Number(radius)).sort((a, b) => a.distance_meters - b.distance_meters);
        res.json(nearbyFlags);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT *,
            CASE WHEN skill_level = 0 THEN 'Bronze'
                 WHEN skill_level < 10 THEN 'Silver'
                 WHEN skill_level < 20 THEN 'Gold'
                 ELSE 'Diamond' END AS rank
            FROM players
            WHERE is_active = true
            ORDER BY skill_level DESC, flags_caught_total DESC
            LIMIT 50
        `);
        res.json(result.rows.map(normalizePlayer));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/player/:id/recover-energy', async (req, res) => {
    try {
        const player = await getPlayer(await resolvePlayerId(req));
        if (!player) return res.status(404).json({ error: 'Player not found' });

        const now = new Date();
        const lastRecovery = new Date(player.last_energy_recovery || now);
        const minutesSinceRecovery = (now - lastRecovery) / (1000 * 60);

        if (minutesSinceRecovery < 15) {
            return res.status(400).json({ error: `Energy recovery available in ${(15 - minutesSinceRecovery).toFixed(1)} minutes`, minutes_until_recovery: 15 - minutesSinceRecovery });
        }

        const previousEnergy = Number(player.current_energy);
        const recovery = rules.applyPassiveRecovery(previousEnergy, player.last_energy_recovery, now);
        const newEnergy = recovery.current_energy;
        const updatedPlayer = await updatePlayer(player.id, { current_energy: newEnergy, last_energy_recovery: now });
        res.json({ success: true, energy_recovered: newEnergy - previousEnergy, new_energy: updatedPlayer.current_energy, previous_energy: previousEnergy, message: `Recovered ${newEnergy - previousEnergy}% energy. Current: ${newEnergy}%` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/player/me/backpack', verifyJWT, async (req, res) => {
    try {
        const playerId = await resolvePlayerId(req);
        const player = await getPlayer(playerId);
        if (!player) return res.status(404).json({ error: 'Player not found' });

        const result = await db.query(`
            SELECT i.*, pi.quantity
            FROM player_items pi
            JOIN items i ON i.id = pi.item_id
            WHERE pi.player_id = $1
            ORDER BY pi.acquired_at DESC
        `, [playerId]);

        const backpack = result.rows.map(item => ({
            id: item.id,
            type: item.type,
            company_id: item.company_id,
            company_name: item.company_name,
            premium_flags_count: item.type === 'premium_flag' ? item.quantity : 0,
            qr_codes_available: item.qr_code && item.qr_status === 'available' ? 1 : 0,
            last_reward: item.name,
            qr_codes: item.qr_code ? [{ id: `qr-${item.id}`, title: item.name, code: item.qr_code, status: item.qr_status, estimated_value: item.estimated_value }] : []
        }));

        res.json(backpack);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/player/:id/backpack', async (req, res) => {
    try {
        const playerId = await resolvePlayerId(req);
        const player = await getPlayer(playerId);
        if (!player) return res.status(404).json({ error: 'Player not found' });

        const result = await db.query(`
            SELECT i.*, pi.quantity
            FROM player_items pi
            JOIN items i ON i.id = pi.item_id
            WHERE pi.player_id = $1
            ORDER BY pi.acquired_at DESC
        `, [playerId]);

        const backpack = result.rows.map(item => ({
            id: item.id,
            type: item.type,
            company_id: item.company_id,
            company_name: item.company_name,
            premium_flags_count: item.type === 'premium_flag' ? item.quantity : 0,
            qr_codes_available: item.qr_code && item.qr_status === 'available' ? 1 : 0,
            last_reward: item.name,
            qr_codes: item.qr_code ? [{ id: `qr-${item.id}`, title: item.name, code: item.qr_code, status: item.qr_status, estimated_value: item.estimated_value }] : []
        }));

        res.json(backpack);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/player/me/captures', verifyJWT, async (req, res) => {
    if (req.user.accountType !== 'player') {
        return res.status(403).json({ error: 'Apenas jogadores têm histórico de capturas.' });
    }

    const playerId = req.user.userId;

    try {
        const queryText = `
            SELECT ch.id, ch.coins_earned, ch.captured_at, f.type AS flag_title, f.type AS flag_type
            FROM capture_history ch
            JOIN flags f ON ch.flag_id = f.id
            WHERE ch.player_id = $1
            ORDER BY ch.captured_at DESC
        `;
        const result = await db.query(queryText, [playerId]);

        res.json({
            success: true,
            count: result.rows.length,
            captures: result.rows
        });
    } catch (error) {
        console.error('Erro ao buscar histórico de capturas:', error);
        res.status(500).json({ error: 'Erro interno ao processar o histórico de capturas.' });
    }
});

app.post('/api/player/me/backpack/use', verifyJWT, async (req, res) => {
    if (req.user.accountType !== 'player') {
        return res.status(403).json({ error: 'Apenas jogadores podem usar itens.' });
    }

    const playerUserId = req.user.userId;
    const playerId = req.user.playerId;
    const { item_id } = req.body;

    if (!item_id) {
        return res.status(400).json({ error: 'O ID do item é obrigatório.' });
    }

    const client = await db.pool.connect();

    try {
        await client.query('BEGIN');

        const checkItemQuery = `
            SELECT pi.id AS player_item_id, i.item_type, i.effect_value, i.type AS item_name
            FROM player_items pi
            JOIN items i ON pi.item_id = i.id
            WHERE pi.player_id = $1 AND pi.item_id = $2
            FOR UPDATE
        `;
        const itemResult = await client.query(checkItemQuery, [playerId, item_id]);

        if (itemResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Item não encontrado na tua mochila.' });
        }

        const item = itemResult.rows[0];

        if (item.item_type !== 'consumable') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Este item não pode ser consumido.' });
        }

        const updateEnergyQuery = `
            UPDATE players
            SET current_energy = LEAST(100, current_energy + $1)
            WHERE user_id = $2
            RETURNING current_energy
        `;
        const playerResult = await client.query(updateEnergyQuery, [item.effect_value, playerUserId]);
        const novaEnergia = playerResult.rows[0].current_energy;

        await client.query('DELETE FROM player_items WHERE id = $1', [item.player_item_id]);

        await client.query('COMMIT');

        res.json({
            success: true,
            message: `Usaste o item com sucesso e recuperaste ${item.effect_value} de energia!`,
            current_energy: novaEnergia
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Erro ao consumir item:', error);
        res.status(500).json({ error: 'Erro interno ao processar o uso do item.' });
    } finally {
        client.release();
    }
});

app.get('/api/player/me/settings', verifyJWT, async (req, res) => {
    try {
        const playerId = await resolvePlayerId(req);
        const result = await db.query('SELECT * FROM player_settings WHERE player_id = $1', [playerId]);
        if (!result.rows[0]) return res.status(404).json({ error: 'Settings not found' });
        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/player/:id/settings', async (req, res) => {
    try {
        const playerId = await resolvePlayerId(req);
        const result = await db.query('SELECT * FROM player_settings WHERE player_id = $1', [playerId]);
        if (!result.rows[0]) return res.status(404).json({ error: 'Settings not found' });
        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/player/me/settings', verifyJWT, async (req, res) => {
    try {
        const playerId = await resolvePlayerId(req);
        const result = await db.query(`
            INSERT INTO player_settings (player_id, auto_center, show_animations, sound_effects, virtual_step_size, account_visibility, trade_notifications, market_confirmations, language)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (player_id) DO UPDATE SET
                auto_center = EXCLUDED.auto_center,
                show_animations = EXCLUDED.show_animations,
                sound_effects = EXCLUDED.sound_effects,
                virtual_step_size = EXCLUDED.virtual_step_size,
                account_visibility = EXCLUDED.account_visibility,
                trade_notifications = EXCLUDED.trade_notifications,
                market_confirmations = EXCLUDED.market_confirmations,
                language = EXCLUDED.language,
                updated_at = NOW()
            RETURNING *
        `, [playerId, req.body.auto_center, req.body.show_animations, req.body.sound_effects, Number(req.body.virtual_step_size || 10), req.body.account_visibility || 'public', req.body.trade_notifications, req.body.market_confirmations, req.body.language || 'pt-PT']);
        res.json({ success: true, settings: result.rows[0], message: 'Settings saved successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/company/dashboard', verifyJWT, async (req, res) => {
    if (req.user.accountType !== 'company') {
        return res.status(403).json({ error: 'Apenas empresas podem aceder ao painel.' });
    }

    try {
        const companyId = req.user.userId;

        const statsResult = await db.query(`
            SELECT
                COUNT(*) FILTER (WHERE captured_at IS NULL)::int   AS active_flags,
                COUNT(*) FILTER (WHERE captured_at IS NOT NULL)::int AS total_captures,
                COALESCE(SUM(coin_value) FILTER (WHERE captured_at IS NOT NULL), 0)::int AS total_coins_distributed,
                COUNT(*)::int AS total_flags
            FROM flags
            WHERE company_id = $1
        `, [companyId]);

        const recentCaptures = await db.query(`
            SELECT
                f.id AS flag_id,
                f.type,
                f.coin_value,
                f.captured_at,
                p.username AS captured_by_username
            FROM flags f
            LEFT JOIN players p ON p.user_id = f.captured_by
            WHERE f.company_id = $1 AND f.captured_at IS NOT NULL
            ORDER BY f.captured_at DESC
            LIMIT 10
        `, [companyId]);

        const stats = statsResult.rows[0] || {
            active_flags: 0,
            total_captures: 0,
            total_coins_distributed: 0,
            total_flags: 0
        };

        res.json({
            success: true,
            dashboard: {
                active_flags: stats.active_flags,
                total_captures: stats.total_captures,
                total_coins_distributed: stats.total_coins_distributed,
                total_flags: stats.total_flags,
                recent_captures: recentCaptures.rows
            }
        });
    } catch (error) {
        console.error('Erro ao carregar dashboard da empresa:', error);
        res.status(500).json({ error: 'Erro interno ao carregar painel.' });
    }
});

app.get('/api/company/flags', verifyJWT, async (req, res) => {
    if (req.user.accountType !== 'company') {
        return res.status(403).json({ error: 'Apenas empresas podem consultar campanhas.' });
    }

    try {
        const result = await db.query(`
            SELECT
                id,
                type,
                type AS title,
                coin_value AS reward_coins,
                is_premium,
                is_qr_code,
                qr_code_token,
                latitude,
                longitude,
                physical_prize_name,
                physical_prize_description,
                physical_prize_value,
                captured_at IS NOT NULL AS is_captured,
                created_at
            FROM flags
            WHERE company_id = $1
            ORDER BY created_at DESC
        `, [req.user.userId]);

        res.json({ success: true, flags: result.rows });
    } catch (error) {
        console.error('Erro ao listar campanhas da empresa:', error);
        res.status(500).json({ error: 'Erro interno ao carregar campanhas.' });
    }
});

app.post('/api/company/flags', verifyJWT, async (req, res) => {
    if (req.user.accountType !== 'company') {
        return res.status(403).json({ error: 'Apenas empresas podem criar campanhas.' });
    }

    const { title, type, latitude, longitude, reward_coins, is_premium, is_qr_code,
            physical_prize_name, physical_prize_description, physical_prize_value } = req.body;
    const numericLatitude = Number(latitude);
    const numericLongitude = Number(longitude);
    const numericReward = Number(reward_coins || 0);

    if (!title || !Number.isFinite(numericLatitude) || !Number.isFinite(numericLongitude)) {
        return res.status(400).json({ error: 'Título, latitude e longitude são obrigatórios.' });
    }

    if (!Number.isFinite(numericReward) || numericReward < 0) {
        return res.status(400).json({ error: 'O prémio em moedas deve ser um número válido.' });
    }

    const qrToken = is_qr_code ? crypto.randomBytes(16).toString('hex') : null;
    const sanitizedPrizeName = String(physical_prize_name || '').trim();
    const sanitizedPrizeDesc = String(physical_prize_description || '').trim();
    const sanitizedPrizeValue = String(physical_prize_value || '').trim();

    try {
        const result = await db.query(`
            INSERT INTO flags (company_id, type, is_premium, is_qr_code, qr_code_token, latitude, longitude,
                               coin_value, energy_value, premium_expires_at,
                               physical_prize_name, physical_prize_description, physical_prize_value)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0,
                    CASE WHEN $3 THEN NOW() + INTERVAL '15 days' ELSE NULL END,
                    NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''))
            RETURNING
                id,
                type,
                type AS title,
                coin_value AS reward_coins,
                is_premium,
                is_qr_code,
                qr_code_token,
                latitude,
                longitude,
                physical_prize_name,
                physical_prize_description,
                physical_prize_value,
                captured_at IS NOT NULL AS is_captured,
                created_at
        `, [req.user.userId, title || type || 'Campanha', Boolean(is_premium), Boolean(is_qr_code), qrToken,
            numericLatitude, numericLongitude, numericReward,
            sanitizedPrizeName, sanitizedPrizeDesc, sanitizedPrizeValue]);

        res.status(201).json({ success: true, flag: result.rows[0] });
    } catch (error) {
        console.error('Erro ao criar campanha da empresa:', error);
        res.status(500).json({ error: 'Erro interno ao criar campanha.' });
    }
});

// ── Package (Pacote) endpoints ──

app.get('/api/company/tiers', (req, res) => {
    const tiers = Object.entries(PACKAGE_TIERS).map(([tier, t]) => ({
        tier: Number(tier), ...t
    }));
    res.json({ success: true, tiers });
});

app.post('/api/company/packages', verifyJWT, async (req, res) => {
    if (req.user.accountType !== 'company') {
        return res.status(403).json({ error: 'Apenas empresas podem criar pacotes.' });
    }

    const { tier, center_latitude, center_longitude,
            prize_count, prize_description, prize_claim_deadline } = req.body;
    const tierNum = Number(tier);
    const tierDef = PACKAGE_TIERS[tierNum];

    if (!tierDef) {
        return res.status(400).json({ error: 'Tier inválido. Escolha entre 1 e 6.' });
    }

    const lat = Number(center_latitude);
    const lng = Number(center_longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(400).json({ error: 'Coordenadas do centro são obrigatórias.' });
    }

    // ── Matemática da divisão do pacote ──
    // total_flags (definido pelo tier) = prize_flags + reward_flags
    // prize_flags = prize_count × 20  (cada prémio real exige 20 bandeiras prize)
    // reward_flags = total_flags - prize_flags  (restantes dão moedas, energia, skills)
    // TODAS as bandeiras (prize + reward) contribuem para o skill do jogador ao serem capturadas.
    // Tier 1 (Starter) não permite prémios: todas as bandeiras são reward.
    const numPrizes = Number(prize_count || 0);
    if (!tierDef.has_prizes && numPrizes > 0) {
        return res.status(400).json({ error: 'O tier Starter não permite prémios.' });
    }

    const prizeFlags = numPrizes * 20;
    if (prizeFlags > tierDef.flags) {
        return res.status(400).json({ error: `Prémios a mais: ${numPrizes} prémios x 20 = ${prizeFlags} bandeiras prize, mas o pacote só tem ${tierDef.flags}.` });
    }

    try {
        const result = await db.query(`
            INSERT INTO flag_packages
                (company_id, tier, total_flags, bingo_count, radius_km, duration_days,
                 price_cents, prize_count, prize_flags, reward_flags,
                 prize_description, prize_claim_deadline,
                 center_latitude, center_longitude, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'draft')
            RETURNING *
        `, [
            req.user.userId, tierNum, tierDef.flags, tierDef.bingos,
            tierDef.radius_km, tierDef.duration_days,
            tierDef.price_cents, numPrizes, prizeFlags, tierDef.flags - prizeFlags,
            String(prize_description || '').trim() || null,
            String(prize_claim_deadline || '').trim() || null,
            lat, lng
        ]);

        res.status(201).json({ success: true, package: result.rows[0] });
    } catch (error) {
        console.error('Erro ao criar pacote:', error);
        res.status(500).json({ error: 'Erro interno ao criar pacote.' });
    }
});

app.get('/api/company/packages', verifyJWT, async (req, res) => {
    if (req.user.accountType !== 'company') {
        return res.status(403).json({ error: 'Apenas empresas podem listar pacotes.' });
    }

    try {
        const result = await db.query(`
            SELECT fp.*,
                   COUNT(f.id)::int AS generated_flags,
                   COUNT(f.id) FILTER (WHERE f.captured_at IS NOT NULL)::int AS captured_flags
            FROM flag_packages fp
            LEFT JOIN flags f ON f.package_id = fp.id
            WHERE fp.company_id = $1
            GROUP BY fp.id
            ORDER BY fp.created_at DESC
        `, [req.user.userId]);

        res.json({ success: true, packages: result.rows });
    } catch (error) {
        console.error('Erro ao listar pacotes:', error);
        res.status(500).json({ error: 'Erro interno ao listar pacotes.' });
    }
});

app.get('/api/company/packages/:id', verifyJWT, async (req, res) => {
    if (req.user.accountType !== 'company') {
        return res.status(403).json({ error: 'Apenas empresas podem ver pacotes.' });
    }

    try {
        const pkgResult = await db.query(`
            SELECT fp.*,
                   COUNT(f.id)::int AS generated_flags,
                   COUNT(f.id) FILTER (WHERE f.captured_at IS NOT NULL)::int AS captured_flags,
                   COUNT(f.id) FILTER (WHERE f.flag_category = 'prize' AND f.captured_at IS NOT NULL)::int AS captured_prize_flags
            FROM flag_packages fp
            LEFT JOIN flags f ON f.package_id = fp.id
            WHERE fp.id = $1 AND fp.company_id = $2
            GROUP BY fp.id
        `, [req.params.id, req.user.userId]);

        if (pkgResult.rows.length === 0) {
            return res.status(404).json({ error: 'Pacote não encontrado.' });
        }

        res.json({ success: true, package: pkgResult.rows[0] });
    } catch (error) {
        console.error('Erro ao carregar pacote:', error);
        res.status(500).json({ error: 'Erro interno ao carregar pacote.' });
    }
});

app.post('/api/company/packages/:id/activate', verifyJWT, async (req, res) => {
    if (req.user.accountType !== 'company') {
        return res.status(403).json({ error: 'Apenas empresas podem ativar pacotes.' });
    }

    const packageId = Number(req.params.id);
    const client = await db.pool.connect();

    try {
        await client.query('BEGIN');

        const pkgResult = await client.query(
            'SELECT * FROM flag_packages WHERE id = $1 AND company_id = $2 FOR UPDATE',
            [packageId, req.user.userId]
        );

        if (pkgResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Pacote não encontrado.' });
        }

        const pkg = pkgResult.rows[0];

        if (pkg.status !== 'draft') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: `Pacote já está '${pkg.status}'. Só pacotes 'draft' podem ser ativados.` });
        }

        const tierDef = PACKAGE_TIERS[pkg.tier];
        const centerLat = Number(pkg.center_latitude);
        const centerLng = Number(pkg.center_longitude);
        const totalFlags = pkg.total_flags;
        const prizeFlags = pkg.prize_flags || 0;
        const rewardFlags = pkg.reward_flags || (totalFlags - prizeFlags);

        // ── Distribuição das bandeiras no mapa ──
        // Ex: 5000 flags, 100 prémios → 2000 prize + 3000 reward
        // Prize: tipo 'Prize', dão moedas (5-15) + energia (1-5) + skill (via captura)
        //        Jogador junta 20 prize → funde num código QR do prémio real
        // Reward: tipos aleatórios (Coin, Energy_10, Energy_20, Skill)
        //        Dão moedas e/ou energia + skill (via captura)
        const flagTypes = ['Coin', 'Energy_10', 'Energy_20', 'Skill'];
        const batchSize = 500;
        let inserted = 0;

        // Gerar bandeiras prize (prémio real — jogador precisa de 20 para fundir)
        for (let i = 0; i < prizeFlags; i += batchSize) {
            const count = Math.min(batchSize, prizeFlags - i);
            const values = [];
            const params = [];
            let paramIdx = 1;

            for (let j = 0; j < count; j++) {
                const pt = randomPointInRadius(centerLat, centerLng, tierDef.radius_km);
                const coinVal = Math.floor(Math.random() * 10) + 5;
                const energyVal = Math.floor(Math.random() * 5) + 1;
                values.push(`($${paramIdx}, $${paramIdx+1}, $${paramIdx+2}, $${paramIdx+3}, $${paramIdx+4}, $${paramIdx+5}, $${paramIdx+6}, $${paramIdx+7})`);
                params.push(req.user.userId, packageId, 'Prize', pt.latitude, pt.longitude, coinVal, energyVal, 'prize');
                paramIdx += 8;
            }

            await client.query(`
                INSERT INTO flags (company_id, package_id, type, latitude, longitude, coin_value, energy_value, flag_category)
                VALUES ${values.join(', ')}
            `, params);
            inserted += count;
        }

        // Gerar bandeiras reward (recompensas de jogo: moedas, energia, skills)
        for (let i = 0; i < rewardFlags; i += batchSize) {
            const count = Math.min(batchSize, rewardFlags - i);
            const values = [];
            const params = [];
            let paramIdx = 1;

            for (let j = 0; j < count; j++) {
                const pt = randomPointInRadius(centerLat, centerLng, tierDef.radius_km);
                const flagType = flagTypes[Math.floor(Math.random() * flagTypes.length)];
                let coinVal = 0;
                let energyVal = 0;

                if (flagType === 'Coin') {
                    coinVal = Math.floor(Math.random() * 40) + 10;
                } else if (flagType === 'Energy_10') {
                    energyVal = 10;
                    coinVal = Math.floor(Math.random() * 5);
                } else if (flagType === 'Energy_20') {
                    energyVal = 20;
                    coinVal = Math.floor(Math.random() * 5);
                } else {
                    coinVal = Math.floor(Math.random() * 15) + 5;
                    energyVal = Math.floor(Math.random() * 3) + 1;
                }

                values.push(`($${paramIdx}, $${paramIdx+1}, $${paramIdx+2}, $${paramIdx+3}, $${paramIdx+4}, $${paramIdx+5}, $${paramIdx+6}, $${paramIdx+7})`);
                params.push(req.user.userId, packageId, flagType, pt.latitude, pt.longitude, coinVal, energyVal, 'reward');
                paramIdx += 8;
            }

            await client.query(`
                INSERT INTO flags (company_id, package_id, type, latitude, longitude, coin_value, energy_value, flag_category)
                VALUES ${values.join(', ')}
            `, params);
            inserted += count;
        }

        const expiresAt = tierDef.duration_days
            ? `NOW() + INTERVAL '${tierDef.duration_days} days'`
            : 'NULL';

        await client.query(`
            UPDATE flag_packages
            SET status = 'active', activated_at = NOW(), expires_at = ${expiresAt}
            WHERE id = $1
        `, [packageId]);

        await client.query('COMMIT');

        res.json({
            success: true,
            message: `Pacote ativado! ${inserted} bandeiras distribuídas (${prizeFlags} prize + ${rewardFlags} reward) num raio de ${tierDef.radius_km}km.`,
            flags_generated: inserted,
            prize_flags: prizeFlags,
            reward_flags: rewardFlags
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Erro ao ativar pacote:', error);
        res.status(500).json({ error: 'Erro interno ao ativar pacote.' });
    } finally {
        client.release();
    }
});

async function captureQrFlag(req, res) {
    if (req.user.accountType !== 'player') {
        return res.status(403).json({ error: 'Apenas jogadores podem capturar campanhas QR.' });
    }

    const { token } = req.params;
    const playerUserId = req.user.userId;
    const playerId = req.user.playerId;

    if (!token) {
        return res.status(400).json({ error: 'Token QR obrigatório.' });
    }

    const client = await db.pool.connect();

    try {
        await client.query('BEGIN');

        const flagResult = await client.query(`
            SELECT id, type, coin_value, captured_at
            FROM flags
            WHERE qr_code_token = $1 AND is_qr_code = true
            FOR UPDATE
        `, [token]);

        if (flagResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Campanha QR inválida ou inexistente.' });
        }

        const flag = flagResult.rows[0];

        if (flag.captured_at) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Esta campanha QR já foi capturada.' });
        }

        const playerResult = await client.query(`
            UPDATE players
            SET coin_wallet = coin_wallet + $1,
                flags_caught_total = flags_caught_total + 1,
                updated_at = NOW()
            WHERE user_id = $2
            RETURNING id, username, coin_wallet, flags_caught_total
        `, [Number(flag.coin_value || 0), playerUserId]);

        if (playerResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Jogador não encontrado.' });
        }

        await client.query(
            'UPDATE flags SET captured_at = NOW(), captured_by = $1 WHERE id = $2',
            [playerId, flag.id]
        );

        await client.query(
            'INSERT INTO capture_history (player_id, flag_id, coins_earned) VALUES ($1, $2, $3)',
            [playerUserId, flag.id, Number(flag.coin_value || 0)]
        );

        await client.query('COMMIT');

        res.json({
            success: true,
            message: `Campanha QR capturada com sucesso! Ganhaste ${Number(flag.coin_value || 0)} moedas.`,
            flag: {
                id: flag.id,
                type: flag.type,
                reward_coins: Number(flag.coin_value || 0)
            },
            player: playerResult.rows[0]
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Erro ao capturar campanha QR:', error);
        res.status(500).json({ error: 'Erro interno ao processar captura QR.' });
    } finally {
        client.release();
    }
}

app.get('/api/flags/capture/:token', verifyJWT, captureQrFlag);
app.post('/api/flags/capture/:token', verifyJWT, captureQrFlag);

app.get('/api/market/listings', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT ml.*, p.username AS seller_name
            FROM market_listings ml
            JOIN players p ON p.id = ml.seller_id
            WHERE ml.status = 'active'
            ORDER BY ml.created_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/market/qr-sale', verifyJWT, async (req, res) => {
    try {
        const playerId = Number(req.user?.playerId || req.body.player_id || 1);
        const { qr_code, item_name, price } = req.body;
        const numericPrice = Number(price);

        if (!qr_code || !item_name || !Number.isFinite(numericPrice) || numericPrice <= 0) {
            return res.status(400).json({ error: 'QR code, item name and positive price are required' });
        }

        const listing = await db.transaction(async (client) => {
            const itemResult = await client.query(`
                SELECT i.* FROM player_items pi
                JOIN items i ON i.id = pi.item_id
                WHERE pi.player_id = $1 AND i.qr_code = $2 AND i.qr_status = 'available'
                FOR UPDATE
            `, [playerId, qr_code]);

            const item = itemResult.rows[0];
            if (!item) {
                const error = new Error('QR code is not available in player backpack');
                error.status = 400;
                throw error;
            }

            await client.query('UPDATE items SET qr_status = $1 WHERE id = $2', ['listed', item.id]);
            const listingResult = await client.query(`
                INSERT INTO market_listings (seller_id, item_id, item_type, item_name, qr_code, price)
                VALUES ($1, $2, 'QR', $3, $4, $5)
                RETURNING *
            `, [playerId, item.id, item_name, qr_code, numericPrice]);
            return listingResult.rows[0];
        });

        res.json({ success: true, listing, message: 'QR listed for sale' });
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message });
    }
});

app.post('/api/market/:listingId/buy', verifyJWT, async (req, res) => {
    const listingId = Number(req.params.listingId);
    const buyerUserId = req.user.userId;
    const buyerPlayerId = req.user.playerId;

    if (req.user.accountType !== 'player') {
        return res.status(403).json({ error: 'Apenas contas do tipo Jogador podem comprar itens.' });
    }

    const client = await db.pool.connect();

    try {
        await client.query('BEGIN');

        const listingQuery = `
            SELECT ml.*, i.id AS item_id, seller.user_id AS seller_user_id
            FROM market_listings ml
            JOIN items i ON ml.item_id = i.id
            JOIN players seller ON seller.id = ml.seller_id
            WHERE ml.id = $1 AND ml.status = 'active'
            FOR UPDATE
        `;
        const listingResult = await client.query(listingQuery, [listingId]);

        if (listingResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Item não encontrado ou já vendido.' });
        }

        const listing = listingResult.rows[0];
        const price = Number(listing.price);
        const sellerPlayerId = Number(listing.seller_id);
        const sellerUserId = Number(listing.seller_user_id);

        if (sellerUserId === Number(buyerUserId)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Não podes comprar o teu próprio item.' });
        }

        const buyerResult = await client.query('SELECT id, coin_wallet FROM players WHERE user_id = $1 FOR UPDATE', [buyerUserId]);

        if (buyerResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Jogador comprador não encontrado.' });
        }

        const buyerCoins = Number(buyerResult.rows[0].coin_wallet);

        if (buyerCoins < price) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Moedas insuficientes para realizar a compra.' });
        }

        await client.query('UPDATE players SET coin_wallet = coin_wallet - $1 WHERE user_id = $2', [price, buyerUserId]);
        await client.query('UPDATE players SET coin_wallet = coin_wallet + $1 WHERE user_id = $2', [price, sellerUserId]);
        await client.query('UPDATE player_items SET player_id = $1 WHERE item_id = $2 AND player_id = $3', [buyerPlayerId, listing.item_id, sellerPlayerId]);
        await client.query("UPDATE market_listings SET status = 'sold', buyer_id = $1, sold_at = NOW() WHERE id = $2", [buyerPlayerId, listingId]);
        await client.query('UPDATE items SET qr_status = $1 WHERE id = $2', ['available', listing.item_id]);
        await client.query(`
            INSERT INTO market_history (listing_id, item_id, seller_id, buyer_id, price_paid, transaction_type)
            VALUES ($1, $2, $3, $4, $5, 'market_sale')
        `, [listingId, listing.item_id, sellerUserId, buyerUserId, price]);

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Compra efetuada com sucesso! O item já está na tua mochila e a transação foi registada.'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Erro na transação de compra:', error);
        res.status(500).json({ error: 'Erro interno ao processar a compra no mercado.' });
    } finally {
        client.release();
    }
});

app.get('/api/trades', verifyJWT, async (req, res) => {
    try {
        const playerId = Number(req.user?.playerId || req.query.player_id || 1);
        const result = await db.query(`
            SELECT t.*, fp.username AS from_player_name, tp.username AS to_player_name
            FROM trade_offers t
            JOIN players fp ON fp.id = t.from_player_id
            JOIN players tp ON tp.id = t.to_player_id
            WHERE t.from_player_id = $1 OR t.to_player_id = $1
            ORDER BY t.created_at DESC
        `, [playerId]);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/trades', verifyJWT, async (req, res) => {
    try {
        const fromPlayerId = Number(req.user?.playerId || req.body.from_player_id || 1);
        const { to_player_id = 2, offered_item, requested_item } = req.body;

        if (!offered_item || !requested_item) {
            return res.status(400).json({ error: 'Offered item and requested item are required' });
        }

        const result = await db.query(`
            INSERT INTO trade_offers (from_player_id, to_player_id, offered_item, requested_item)
            VALUES ($1, $2, $3, $4)
            RETURNING *
        `, [fromPlayerId, Number(to_player_id), offered_item, requested_item]);
        res.json({ success: true, trade: result.rows[0], message: 'Trade offer created' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/trades/:tradeId/respond', verifyJWT, async (req, res) => {
    try {
        const { action } = req.body;
        if (!['accepted', 'declined'].includes(action)) {
            return res.status(400).json({ error: 'Action must be accepted or declined' });
        }

        const result = await db.query(`
            UPDATE trade_offers
            SET status = $1, responded_at = NOW()
            WHERE id = $2 AND status = 'pending'
            RETURNING *
        `, [action, Number(req.params.tradeId)]);

        if (!result.rows[0]) return res.status(404).json({ error: 'Trade not found' });
        res.json({ success: true, trade: result.rows[0], message: `Trade ${action}` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/recharge-ze', async (req, res) => {
    if (process.env.NODE_ENV === 'production') {
        return res.status(403).send('Rota de emergência indisponível em produção.');
    }

    try {
        await db.query("UPDATE players SET current_energy = 300 WHERE id = 9 OR LOWER(username) = 'ze'");
        res.send('<h1>🔋 O Zé foi recarregado com 300 de energia com sucesso! Podes voltar ao jogo e fazer Ctrl+F5.</h1>');
    } catch (err) {
        res.status(500).send('Erro ao recarregar: ' + err.message);
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, req, res, next) => {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Internal server error', message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong' });
});

async function startServer() {
    await initializeDatabase();
    app.listen(PORT, () => {
        console.log(`?? Larforyou Arena Server running on port ${PORT}`);
        console.log(`?? Game available at: http://localhost:${PORT}`);
        console.log(`?? API available at: http://localhost:${PORT}/api`);
    });
}

if (require.main === module) {
    startServer().catch((error) => {
        console.error('? Failed to start server:', error);
        process.exit(1);
    });
}

process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    process.exit(0);
});

module.exports = app;
