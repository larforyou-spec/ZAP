-- schema.sql — Database schema for Larforyou Arena

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    account_type VARCHAR(20) NOT NULL DEFAULT 'player',
    display_name VARCHAR(100),
    company_name VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS players (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    username VARCHAR(100),
    skill_level INTEGER DEFAULT 0,
    flags_caught_total INTEGER DEFAULT 0,
    current_energy NUMERIC(10,2) DEFAULT 100,
    coin_wallet INTEGER DEFAULT 500,
    last_latitude NUMERIC(10,7) DEFAULT 38.7223,
    last_longitude NUMERIC(10,7) DEFAULT -9.1393,
    virtual_latitude NUMERIC(10,7) DEFAULT 38.7223,
    virtual_longitude NUMERIC(10,7) DEFAULT -9.1393,
    is_virtual_mode BOOLEAN DEFAULT false,
    last_energy_recovery TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS player_settings (
    id SERIAL PRIMARY KEY,
    player_id INTEGER UNIQUE NOT NULL REFERENCES players(id),
    auto_center BOOLEAN DEFAULT true,
    show_animations BOOLEAN DEFAULT true,
    sound_effects BOOLEAN DEFAULT true,
    virtual_step_size NUMERIC(10,6) DEFAULT 0.0001,
    account_visibility VARCHAR(20) DEFAULT 'public',
    trade_notifications BOOLEAN DEFAULT true,
    market_confirmations BOOLEAN DEFAULT true,
    language VARCHAR(10) DEFAULT 'pt'
);

CREATE TABLE IF NOT EXISTS flags (
    id SERIAL PRIMARY KEY,
    company_id INTEGER,
    package_id INTEGER,
    type VARCHAR(50) DEFAULT 'Coin',
    flag_category VARCHAR(20) DEFAULT 'reward',
    is_premium BOOLEAN DEFAULT false,
    is_qr_code BOOLEAN DEFAULT false,
    qr_code_token VARCHAR(100),
    latitude NUMERIC(10,7) NOT NULL,
    longitude NUMERIC(10,7) NOT NULL,
    coin_value INTEGER DEFAULT 0,
    energy_value INTEGER DEFAULT 0,
    premium_expires_at TIMESTAMP,
    captured_at TIMESTAMP,
    captured_by INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS capture_history (
    id SERIAL PRIMARY KEY,
    player_id INTEGER NOT NULL,
    flag_id INTEGER NOT NULL,
    coins_earned INTEGER DEFAULT 0,
    captured_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS items (
    id SERIAL PRIMARY KEY,
    type VARCHAR(50) NOT NULL,
    company_id INTEGER,
    company_name VARCHAR(255),
    name VARCHAR(255),
    qr_code VARCHAR(100),
    qr_status VARCHAR(20) DEFAULT 'available',
    estimated_value INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS player_items (
    id SERIAL PRIMARY KEY,
    player_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    quantity INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS market_listings (
    id SERIAL PRIMARY KEY,
    seller_id INTEGER NOT NULL,
    buyer_id INTEGER,
    item_id INTEGER,
    item_type VARCHAR(50),
    item_name VARCHAR(255),
    qr_code VARCHAR(100),
    price INTEGER NOT NULL,
    prize_code_id INTEGER,
    min_bid INTEGER,
    auction_days INTEGER,
    auction_ends_at TIMESTAMP,
    bid_count INTEGER DEFAULT 0,
    highest_bid INTEGER,
    highest_bidder_id INTEGER,
    final_price INTEGER,
    fee_amount INTEGER,
    status VARCHAR(20) DEFAULT 'active',
    sold_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS market_bids (
    id SERIAL PRIMARY KEY,
    listing_id INTEGER NOT NULL REFERENCES market_listings(id),
    bidder_user_id INTEGER NOT NULL,
    bidder_player_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS market_history (
    id SERIAL PRIMARY KEY,
    listing_id INTEGER,
    item_id INTEGER,
    seller_id INTEGER,
    buyer_id INTEGER,
    price_paid INTEGER,
    transaction_type VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trade_offers (
    id SERIAL PRIMARY KEY,
    from_player_id INTEGER NOT NULL,
    to_player_id INTEGER NOT NULL,
    offered_item TEXT,
    requested_item TEXT,
    status VARCHAR(20) DEFAULT 'pending',
    responded_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS flag_packages (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    tier INTEGER NOT NULL,
    total_flags INTEGER NOT NULL,
    bingo_count INTEGER DEFAULT 0,
    prize_count INTEGER DEFAULT 0,
    prize_description TEXT,
    prize_claim_deadline TEXT,
    center_latitude NUMERIC(10,7),
    center_longitude NUMERIC(10,7),
    radius_km NUMERIC(10,3),
    duration_days INTEGER,
    price_cents INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'draft',
    activated_at TIMESTAMP,
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS flash_bingos (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    package_id INTEGER,
    prize_name TEXT NOT NULL,
    scheduled_start TIMESTAMP NOT NULL,
    duration_minutes INTEGER NOT NULL DEFAULT 60,
    store_latitude NUMERIC(10,7),
    store_longitude NUMERIC(10,7),
    bingo_latitude NUMERIC(10,7),
    bingo_longitude NUMERIC(10,7),
    status VARCHAR(20) DEFAULT 'scheduled',
    expires_at TIMESTAMP,
    winner_player_id INTEGER,
    captured_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prize_codes (
    id SERIAL PRIMARY KEY,
    player_id INTEGER NOT NULL,
    package_id INTEGER,
    company_id INTEGER NOT NULL,
    token VARCHAR(20) NOT NULL UNIQUE,
    prize_name TEXT NOT NULL,
    prize_description TEXT,
    prize_claim_deadline TEXT,
    store_latitude NUMERIC(10,7),
    store_longitude NUMERIC(10,7),
    company_name TEXT,
    company_contact TEXT,
    source VARCHAR(10) NOT NULL DEFAULT 'fuse',
    fused_flag_ids INTEGER[],
    bingo_id INTEGER,
    status VARCHAR(20) NOT NULL DEFAULT 'available',
    proximity_expires_at TIMESTAMP,
    qr_activated_at TIMESTAMP,
    qr_expires_at TIMESTAMP,
    burned_at TIMESTAMP,
    validated_by_company_id INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flags_captured ON flags(captured_at);
CREATE INDEX IF NOT EXISTS idx_flags_company ON flags(company_id);
CREATE INDEX IF NOT EXISTS idx_flags_package ON flags(package_id);
CREATE INDEX IF NOT EXISTS idx_players_user ON players(user_id);
CREATE INDEX IF NOT EXISTS idx_prize_codes_player ON prize_codes(player_id);
CREATE INDEX IF NOT EXISTS idx_prize_codes_status ON prize_codes(status);
CREATE INDEX IF NOT EXISTS idx_market_bids_listing ON market_bids(listing_id);
