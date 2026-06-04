// middleware/auth.js — JWT verification middleware (development/testing simulation)
// In production, replace with real jwt.verify() using jsonwebtoken

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-this-secret';

function verifyJWT(req, res, next) {
    // Try Authorization header first
    const authHeader = req.headers.authorization;
    let token = null;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    }

    // Fallback: query param
    if (!token) {
        token = req.query.token;
    }

    if (!token) {
        // Dev mode fallback: check X-Dev-User header for quick testing
        const devUser = req.headers['x-dev-user'];
        if (devUser) {
            try {
                const parsed = JSON.parse(devUser);
                req.user = {
                    userId: parsed.user_id || parsed.userId || 1,
                    playerId: parsed.player_id || parsed.playerId || null,
                    accountType: parsed.account_type || parsed.accountType || 'player',
                    email: parsed.email || 'dev@test.local'
                };
                return next();
            } catch (e) {
                // Not JSON, treat as account type
                req.user = {
                    userId: 1,
                    playerId: 1,
                    accountType: devUser === 'company' ? 'company' : 'player',
                    email: 'dev@test.local'
                };
                return next();
            }
        }

        return res.status(401).json({ error: 'Token de autenticação não fornecido.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = {
            userId: decoded.user_id,
            playerId: decoded.player_id || null,
            accountType: decoded.account_type,
            email: decoded.email
        };
        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expirado. Faz login novamente.' });
        }
        return res.status(401).json({ error: 'Token inválido.' });
    }
}

module.exports = verifyJWT;
