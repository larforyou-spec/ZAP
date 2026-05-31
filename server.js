/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  LARFORYOU ARENA - SERVIDOR COMPLETO                                        ║
 * ║  Express.js server com API endpoints e lógica de jogo completa                ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet({
    contentSecurityPolicy: false, // Allow inline styles for Leaflet
}));
app.use(compression());
app.use(morgan('combined'));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Game State (em memória para demo)
let gameState = {
    players: new Map(),
    flags: [],
    leaderboard: []
};

// Inicializar dados demo
function initializeGame() {
    // Jogador demo
    gameState.players.set(1, {
        id: 1,
        username: 'DemoPlayer',
        skill_level: 0,
        flags_caught_total: 0,
        current_energy: 100,
        coin_wallet: 0,
        is_virtual_mode: false,
        last_latitude: 38.7223,
        last_longitude: -9.1393,
        virtual_latitude: 38.7223,
        virtual_longitude: -9.1393,
        last_energy_recovery: new Date(),
        last_location_update: new Date()
    });

    // Bandeiras demo
    gameState.flags = [
        {
            id: 1,
            type: 'Coin',
            latitude: 38.7225,
            longitude: -9.1395,
            coin_value: 25,
            energy_value: 0,
            captured_at: null,
            captured_by: null
        },
        {
            id: 2,
            type: 'Energy_10',
            latitude: 38.7220,
            longitude: -9.1390,
            coin_value: 0,
            energy_value: 10,
            captured_at: null,
            captured_by: null
        },
        {
            id: 3,
            type: 'Premium_PEC',
            latitude: 38.7230,
            longitude: -9.1400,
            coin_value: 100,
            energy_value: 0,
            captured_at: null,
            captured_by: null,
            premium_expires_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000)
        },
        {
            id: 4,
            type: 'Energy_20',
            latitude: 38.7228,
            longitude: -9.1388,
            coin_value: 0,
            energy_value: 20,
            captured_at: null,
            captured_by: null
        },
        {
            id: 5,
            type: 'Bingo',
            latitude: 38.7218,
            longitude: -9.1398,
            coin_value: 500,
            energy_value: 0,
            captured_at: null,
            captured_by: null,
            premium_expires_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000)
        }
    ];

    console.log(`🎮 Game initialized with ${gameState.flags.length} flags`);
}

// ══ HELPER FUNCTIONS ══
function calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371000; // Earth radius in meters
    const dLat = toRadians(lat2 - lat1);
    const dLng = toRadians(lng2 - lng1);
    const a = 
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function toRadians(degrees) {
    return degrees * (Math.PI / 180);
}

function calculateCaptureRadius(skillLevel) {
    if (skillLevel === 0) return 2.5;
    
    if (skillLevel < 5) {
        return 2.5 + (skillLevel * 3.6);
    } else {
        const level5Radius = 2.5 + (5 * 3.6);
        const additionalRadius = (skillLevel - 5) * 1.8;
        return Math.min(level5Radius + additionalRadius, 50.0);
    }
}

function calculateNewSkillLevel(totalFlags, currentLevel) {
    if (currentLevel >= 25) return 25;

    let newLevel = 0;
    let flagsNeeded = 100;

    while (totalFlags >= flagsNeeded && newLevel < 5) {
        newLevel++;
        if (newLevel < 5) {
            flagsNeeded *= 2;
        }
    }

    if (newLevel >= 5) {
        const remainingFlags = totalFlags - 800;
        const additionalLevels = Math.floor(remainingFlags / 100);
        newLevel = Math.min(5 + additionalLevels, 25);
    }

    return newLevel;
}

// ══ API ENDPOINTS ══

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Larforyou Arena API is running',
        timestamp: new Date().toISOString(),
        players: gameState.players.size,
        flags: gameState.flags.filter(f => !f.captured_at).length
    });
});

// Get player
app.get('/api/player/:id', (req, res) => {
    try {
        const player = gameState.players.get(parseInt(req.params.id));
        if (!player) {
            return res.status(404).json({ error: 'Player not found' });
        }

        // Add calculated fields
        player.capture_radius = calculateCaptureRadius(player.skill_level);
        
        res.json(player);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update player location
app.put('/api/player/:id/location', (req, res) => {
    try {
        const playerId = parseInt(req.params.id);
        const { latitude, longitude, is_virtual } = req.body;
        
        const player = gameState.players.get(playerId);
        if (!player) {
            return res.status(404).json({ error: 'Player not found' });
        }

        const oldLat = is_virtual ? player.virtual_latitude : player.last_latitude;
        const oldLng = is_virtual ? player.virtual_longitude : player.last_longitude;

        // Calculate distance and energy cost
        const distance = calculateDistance(oldLat, oldLng, latitude, longitude);
        let energyCost = 0;
        
        if (distance > 0) {
            if (is_virtual) {
                energyCost = (distance / 100) * 15; // 15% per km in virtual mode
            } else {
                energyCost = (distance / 100) * 10; // 10% per 100m
            }
        }

        // Check energy
        if (player.current_energy < energyCost) {
            return res.status(400).json({ error: 'Insufficient energy for this movement' });
        }

        // Update player
        if (is_virtual) {
            player.virtual_latitude = latitude;
            player.virtual_longitude = longitude;
            player.is_virtual_mode = true;
        } else {
            player.last_latitude = latitude;
            player.last_longitude = longitude;
            player.is_virtual_mode = false;
        }

        player.current_energy -= energyCost;
        player.last_location_update = new Date();

        // Check for flag captures
        const captureRadius = calculateCaptureRadius(player.skill_level);
        const capturedFlags = [];

        gameState.flags.forEach(flag => {
            if (flag.captured_at) return;

            const flagDistance = calculateDistance(latitude, longitude, flag.latitude, flag.longitude);
            if (flagDistance <= captureRadius) {
                // Capture flag
                flag.captured_at = new Date();
                flag.captured_by = playerId;

                // Update player stats
                player.flags_caught_total += 1;
                player.coin_wallet += flag.coin_value || 0;
                player.current_energy = Math.min(100, player.current_energy + (flag.energy_value || 0));

                // Check level up
                const newLevel = calculateNewSkillLevel(player.flags_caught_total, player.skill_level);
                const levelUp = newLevel > player.skill_level;
                player.skill_level = newLevel;

                capturedFlags.push({
                    flag: flag,
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
        });

        res.json({
            success: true,
            player: player,
            distance_moved: distance,
            energy_spent: energyCost,
            flags_captured: capturedFlags,
            message: `Moved ${distance.toFixed(2)}m, spent ${energyCost.toFixed(1)}% energy`
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Virtual movement
app.post('/api/player/:id/virtual-move', (req, res) => {
    try {
        const playerId = parseInt(req.params.id);
        const { direction, step_size = 10 } = req.body;
        
        const player = gameState.players.get(playerId);
        if (!player) {
            return res.status(404).json({ error: 'Player not found' });
        }

        if (!player.is_virtual_mode) {
            return res.status(400).json({ error: 'Virtual mode is not enabled' });
        }

        // Calculate new position
        const currentLat = player.virtual_latitude || player.last_latitude;
        const currentLng = player.virtual_longitude || player.last_longitude;
        
        let newLat = currentLat;
        let newLng = currentLng;

        // Convert step size to degrees
        const latStep = step_size / 111000;
        const lngStep = step_size / (111000 * Math.cos(currentLat * Math.PI / 180));

        switch (direction.toLowerCase()) {
            case 'up':
            case 'w':
                newLat += latStep;
                break;
            case 'down':
            case 's':
                newLat -= latStep;
                break;
            case 'left':
            case 'a':
                newLng -= lngStep;
                break;
            case 'right':
            case 'd':
                newLng += lngStep;
                break;
            default:
                return res.status(400).json({ error: 'Invalid direction' });
        }

        // Check bounds (1km radius)
        const distanceFromCenter = calculateDistance(
            player.virtual_latitude || player.last_latitude,
            player.virtual_longitude || player.last_longitude,
            newLat, newLng
        );

        if (distanceFromCenter > 1000) {
            return res.status(400).json({ error: 'Movement exceeds virtual mode bounds (1km radius)' });
        }

        // Energy cost (1.5x)
        const energyCost = (step_size / 100) * 15;

        if (player.current_energy < energyCost) {
            return res.status(400).json({ 
                error: `Insufficient energy. Need ${energyCost.toFixed(1)}%, have ${player.current_energy.toFixed(1)}%` 
            });
        }

        // Update player
        player.virtual_latitude = newLat;
        player.virtual_longitude = newLng;
        player.current_energy -= energyCost;
        player.last_location_update = new Date();

        // Check for flag captures
        const captureRadius = calculateCaptureRadius(player.skill_level);
        const capturedFlags = [];

        gameState.flags.forEach(flag => {
            if (flag.captured_at) return;

            const flagDistance = calculateDistance(newLat, newLng, flag.latitude, flag.longitude);
            if (flagDistance <= captureRadius) {
                flag.captured_at = new Date();
                flag.captured_by = playerId;

                player.flags_caught_total += 1;
                player.coin_wallet += flag.coin_value || 0;
                player.current_energy = Math.min(100, player.current_energy + (flag.energy_value || 0));

                const newLevel = calculateNewSkillLevel(player.flags_caught_total, player.skill_level);
                const levelUp = newLevel > player.skill_level;
                player.skill_level = newLevel;

                capturedFlags.push({
                    flag: flag,
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
        });

        res.json({
            success: true,
            old_position: { latitude: currentLat, longitude: currentLng },
            new_position: { latitude: newLat, longitude: newLng },
            distance_moved: step_size,
            energy_spent: energyCost,
            remaining_energy: player.current_energy,
            flags_captured: capturedFlags,
            message: `Moved ${direction} ${stepSize}m, spent ${energyCost.toFixed(1)}% energy`
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Recover energy
app.post('/api/player/:id/recover-energy', (req, res) => {
    try {
        const playerId = parseInt(req.params.id);
        const player = gameState.players.get(playerId);
        
        if (!player) {
            return res.status(404).json({ error: 'Player not found' });
        }

        const now = new Date();
        const lastRecovery = new Date(player.last_energy_recovery || now);
        const minutesSinceRecovery = (now - lastRecovery) / (1000 * 60);

        if (minutesSinceRecovery < 15) {
            return res.status(400).json({
                error: `Energy recovery available in ${(15 - minutesSinceRecovery).toFixed(1)} minutes`,
                minutes_until_recovery: 15 - minutesSinceRecovery
            });
        }

        const energyRecovered = 10;
        const newEnergy = Math.min(100, player.current_energy + energyRecovered);

        if (energyRecovered <= 0) {
            return res.status(400).json({
                error: 'Energy is already full',
                current_energy: player.current_energy
            });
        }

        player.current_energy = newEnergy;
        player.last_energy_recovery = now;

        res.json({
            success: true,
            energy_recovered: energyRecovered,
            new_energy: newEnergy,
            previous_energy: player.current_energy + energyRecovered,
            message: `Recovered ${energyRecovered}% energy. Current: ${newEnergy}%`
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get nearby flags
app.get('/api/flags/nearby', (req, res) => {
    try {
        const { latitude, longitude, radius = 100 } = req.query;
        
        const nearbyFlags = gameState.flags.filter(flag => {
            if (flag.captured_at) return false;
            
            // Check premium expiration
            if (flag.premium_expires_at && new Date(flag.premium_expires_at) < new Date()) {
                return false;
            }

            const distance = calculateDistance(
                parseFloat(latitude), 
                parseFloat(longitude), 
                flag.latitude, 
                flag.longitude
            );
            
            flag.distance_meters = distance;
            return distance <= parseFloat(radius);
        });

        // Sort by distance
        nearbyFlags.sort((a, b) => a.distance_meters - b.distance_meters);

        res.json(nearbyFlags);

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get leaderboard
app.get('/api/leaderboard', (req, res) => {
    try {
        const players = Array.from(gameState.players.values())
            .filter(p => p.is_active !== false)
            .sort((a, b) => {
                if (b.skill_level !== a.skill_level) {
                    return b.skill_level - a.skill_level;
                }
                return b.flags_caught_total - a.flags_caught_total;
            })
            .slice(0, 50)
            .map(player => ({
                ...player,
                rank: player.skill_level === 0 ? 'Bronze' : 
                      player.skill_level < 10 ? 'Silver' : 
                      player.skill_level < 20 ? 'Gold' : 'Diamond'
            }));

        res.json(players);

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get player backpack
app.get('/api/player/:id/backpack', (req, res) => {
    try {
        // Placeholder - empty backpack for demo
        res.json([]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Serve frontend for all other routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling
app.use((error, req, res, next) => {
    console.error('Server error:', error);
    res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Not found',
        message: `Route ${req.method} ${req.path} not found`
    });
});

// Initialize game and start server
initializeGame();

app.listen(PORT, () => {
    console.log(`🚀 Larforyou Arena Server running on port ${PORT}`);
    console.log(`📱 Game available at: http://localhost:${PORT}`);
    console.log(`🔗 API available at: http://localhost:${PORT}/api`);
    console.log(`🎮 Game ready! Open http://localhost:${PORT} to play`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    process.exit(0);
});

module.exports = app;
