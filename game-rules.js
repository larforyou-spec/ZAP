// game-rules.js — Global game configuration and rule functions

const RULES = {
    // Distances (meters)
    CAPTURE_RADIUS_BASE: 50,
    BINGO_ALERT_RADIUS: 250,
    BINGO_CAPTURE_RADIUS: 50,
    PRIZE_ACTIVATION_RADIUS: 50,

    // Timers
    PROXIMITY_TIMER_SECONDS: 300,  // 5 minutes
    QR_LIFESPAN_SECONDS: 30,
    BINGO_MAX_DURATION_HOURS: 24,

    // Economy
    MARKET_FEE_RATE: 0.025,  // 2.5%
    DAILY_LISTING_COST: 2,   // 2 coins per day

    // Energy
    MAX_ENERGY: 100,
    PASSIVE_RECOVERY_RATE: 1,        // energy points per minute
    PASSIVE_RECOVERY_INTERVAL: 60000, // 1 minute in ms
    VIRTUAL_ENERGY_MULTIPLIER: 1.5,

    // Skill
    BASE_CAPTURE_RADIUS: 50,
    RADIUS_PER_LEVEL: 5,
    FLAGS_PER_LEVEL: 10,
    MAX_SKILL_LEVEL: 100
};

function getCaptureRadius(skillLevel) {
    return RULES.BASE_CAPTURE_RADIUS + (Number(skillLevel || 0) * RULES.RADIUS_PER_LEVEL);
}

function calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calculateEnergyCost(distanceMeters, isVirtual) {
    const baseCost = distanceMeters * 0.05;
    return isVirtual ? baseCost * RULES.VIRTUAL_ENERGY_MULTIPLIER : baseCost;
}

function calculateSkillLevel(flagsCaught, currentLevel) {
    const newLevel = Math.min(
        RULES.MAX_SKILL_LEVEL,
        Math.floor(flagsCaught / RULES.FLAGS_PER_LEVEL)
    );
    return Math.max(newLevel, currentLevel);
}

function applyPassiveRecovery(currentEnergy, lastRecoveryTime, now) {
    if (!lastRecoveryTime) {
        return { energy: currentEnergy, lastRecoveryTime: now };
    }

    const elapsed = now.getTime() - new Date(lastRecoveryTime).getTime();
    const intervals = Math.floor(elapsed / RULES.PASSIVE_RECOVERY_INTERVAL);

    if (intervals <= 0) {
        return { energy: currentEnergy, lastRecoveryTime };
    }

    const recovered = Math.min(
        RULES.MAX_ENERGY,
        currentEnergy + (intervals * RULES.PASSIVE_RECOVERY_RATE)
    );

    return {
        energy: recovered,
        lastRecoveryTime: new Date(new Date(lastRecoveryTime).getTime() + intervals * RULES.PASSIVE_RECOVERY_INTERVAL)
    };
}

module.exports = {
    ...RULES,
    getCaptureRadius,
    calculateDistance,
    calculateEnergyCost,
    calculateSkillLevel,
    applyPassiveRecovery
};
