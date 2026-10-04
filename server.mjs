import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = join(root, 'data');
let googleMapsKey = process.env.GOOGLE_MAPS_API_KEY || '';
if (!googleMapsKey) {
  try {
    const envFile = await readFile(join(root, '.env'), 'utf8');
    googleMapsKey = envFile.match(/^GOOGLE_MAPS_API_KEY=(.+)$/m)?.[1]?.trim() || '';
  } catch {}
}
await mkdir(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'goride.sqlite'));
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    phone TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS otp_challenges (
    id INTEGER PRIMARY KEY,
    phone TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    consumed_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS otp_phone_created ON otp_challenges(phone, created_at DESC);
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS sessions_token_hash ON auth_sessions(token_hash);
  CREATE TABLE IF NOT EXISTS rides (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    pickup TEXT NOT NULL,
    destination TEXT NOT NULL,
    ride_type TEXT NOT NULL CHECK (ride_type IN ('GoRide', 'GoRide XL')),
    estimated_fare REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'accepted', 'in_progress', 'completed', 'cancelled')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS rides_user_created ON rides(user_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS places (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    area TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS places_name ON places(name);
  CREATE TABLE IF NOT EXISTS ride_types (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    icon TEXT NOT NULL DEFAULT '🚗',
    seats INTEGER NOT NULL,
    eta_minutes INTEGER NOT NULL,
    base_fare REAL NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
  );
  CREATE TABLE IF NOT EXISTS fare_rules (
    route_key TEXT NOT NULL,
    ride_type_id INTEGER NOT NULL REFERENCES ride_types(id) ON DELETE CASCADE,
    price REAL NOT NULL CHECK (price > 0),
    PRIMARY KEY (route_key, ride_type_id)
  );
`);

if (!db.prepare("SELECT 1 FROM pragma_table_info('ride_types') WHERE name = 'icon'").get()) {
  db.exec("ALTER TABLE ride_types ADD COLUMN icon TEXT NOT NULL DEFAULT '🚗'");
}
const ridesTable = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rides'").get()?.sql || '';
if (ridesTable.includes("ride_type IN ('GoRide', 'GoRide XL')")) {
  db.exec(`
    CREATE TABLE rides_new (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      pickup TEXT NOT NULL,
      destination TEXT NOT NULL,
      ride_type TEXT NOT NULL,
      estimated_fare REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'accepted', 'in_progress', 'completed', 'cancelled')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO rides_new (id, user_id, pickup, destination, ride_type, estimated_fare, status, created_at)
      SELECT id, user_id, pickup, destination, ride_type, estimated_fare, status, created_at FROM rides;
    DROP TABLE rides;
    ALTER TABLE rides_new RENAME TO rides;
    CREATE INDEX IF NOT EXISTS rides_user_created ON rides(user_id, created_at DESC);
  `);
}

const places = [
  ['Republic Square', 'Malé', 4.17555, 73.50919],
  ['Artificial Beach', 'Malé', 4.17184, 73.51437],
  ['Male Fish Market', 'Malé', 4.17629, 73.51089],
  ['Social Centre', 'Malé', 4.17621, 73.51004],
  ['Indira Gandhi Memorial Hospital', 'Malé', 4.17783, 73.52019],
  ['ADK Hospital', 'Malé', 4.17648, 73.51755],
  ['National Museum', 'Malé', 4.17529, 73.51019],
  ['Sultan Park', 'Malé', 4.17520, 73.51077],
  ['Rasfannu Beach', 'Malé', 4.18113, 73.50338],
  ['Velana International Airport', 'Hulhulé', 4.19158, 73.52908],
  ['Hulhumalé Central Park', 'Hulhumalé', 4.21322, 73.54078],
  ['Hulhumalé Ferry Terminal', 'Hulhumalé', 4.21523, 73.54436]
];
const insertPlace = db.prepare('INSERT OR IGNORE INTO places (name, area, latitude, longitude) VALUES (?, ?, ?, ?)');
for (const place of places) insertPlace.run(...place);
const insertRideType = db.prepare('INSERT OR IGNORE INTO ride_types (name, icon, seats, eta_minutes, base_fare, enabled) VALUES (?, ?, ?, ?, ?, ?)');
insertRideType.run('GoRide', '🚗', 4, 4, 30, 1);
insertRideType.run('GoRide XL', '🚙', 6, 7, 30, 1);
db.prepare("UPDATE ride_types SET icon = '🚙' WHERE name = 'GoRide XL' AND icon = '🚗'").run();
db.prepare("UPDATE ride_types SET base_fare = 30 WHERE name IN ('GoRide', 'GoRide XL')").run();

const port = Number(process.env.PORT || 3000);
const mode = process.env.NODE_ENV || 'development';
const otpSecret = process.env.OTP_SECRET || 'local-development-only-change-before-deploy';
if (mode === 'production' && (!process.env.OTP_SECRET || process.env.OTP_SECRET.length < 32)) {
  throw new Error('Set OTP_SECRET to a random value of at least 32 characters in production.');
}
const otpLifetimeMs = 5 * 60 * 1000;
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const requestLog = new Map();

// Maldives taxi fares are set by the travel zones, rather than by distance.
// Vehicle types with up to six seats use the standard column; 7–10 seats use
// the larger-vehicle column.
const fareTable = {
  local: [30, 45],
  malePhase1: [85, 125],
  malePhase2: [100, 155],
  phase1Phase2: [40, 60],
  airportMale: [70, 105],
  airportPhase1: [80, 120],
  airportPhase2: [85, 130]
};

function normalizePlaceName(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function fareZone(value) {
  const name = normalizePlaceName(value);
  if (/(velana|via\b|airport|hulhule)/.test(name)) return 'airport';
  if (/(phase\s*2|phase\s*ii|phase2|hulhumale.*2)/.test(name)) return 'phase2';
  if (/(hulhumale|phase\s*1|phase\s*i\b|phase1)/.test(name)) return 'phase1';
  if (/(male|male'|male\b|male city)/.test(name)) return 'male';
  return 'local';
}

const fareRoutes = [
  ['local', 'Within the same zone'],
  ['malePhase1', 'Malé ↔ Hulhumalé Phase 1'],
  ['malePhase2', 'Malé ↔ Hulhumalé Phase 2'],
  ['phase1Phase2', 'Hulhumalé Phase 1 ↔ Phase 2'],
  ['airportMale', 'Airport (VIA) ↔ Malé'],
  ['airportPhase1', 'Airport (VIA) ↔ Hulhumalé Phase 1'],
  ['airportPhase2', 'Airport (VIA) ↔ Hulhumalé Phase 2']
];

function fareRouteKey(pickup, destination) {
  const from = fareZone(pickup), to = fareZone(destination);
  const pair = new Set([from, to]);
  if (pair.has('airport')) return pair.has('male') ? 'airportMale' : pair.has('phase2') ? 'airportPhase2' : pair.has('phase1') ? 'airportPhase1' : 'local';
  if (pair.has('male') && pair.has('phase2')) return 'malePhase2';
  if (pair.has('male') && pair.has('phase1')) return 'malePhase1';
  if (pair.has('phase1') && pair.has('phase2')) return 'phase1Phase2';
  return 'local';
}

function defaultFare(routeKey, seats, fallbackFare) {
  if (routeKey === 'local') return fallbackFare;
  const column = Number(seats) >= 7 ? 1 : 0;
  return fareTable[routeKey]?.[column] ?? fallbackFare;
}

function ensureFareRules(rideType) {
  const insert = db.prepare('INSERT OR IGNORE INTO fare_rules (route_key, ride_type_id, price) VALUES (?, ?, ?)');
  for (const [routeKey] of fareRoutes) insert.run(routeKey, rideType.id, defaultFare(routeKey, rideType.seats, rideType.baseFare));
}

function zoneFare(pickup, destination, seats, fallbackFare, rideTypeId) {
  const zone = fareRouteKey(pickup, destination);
  const saved = Number.isInteger(Number(rideTypeId)) ? db.prepare('SELECT price FROM fare_rules WHERE route_key = ? AND ride_type_id = ?').get(zone, Number(rideTypeId)) : null;
  return { fare: saved?.price ?? defaultFare(zone, seats, fallbackFare), zone };
}

for (const rideType of db.prepare('SELECT id, seats, base_fare AS baseFare FROM ride_types').all()) ensureFareRules(rideType);
db.prepare("UPDATE ride_types SET base_fare = (SELECT price FROM fare_rules WHERE fare_rules.ride_type_id = ride_types.id AND route_key = 'local') WHERE EXISTS (SELECT 1 FROM fare_rules WHERE fare_rules.ride_type_id = ride_types.id AND route_key = 'local')").run();

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function getBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 16_384) {
        reject(new Error('Request body is too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('Request body must be valid JSON')); }
    });
    req.on('error', reject);
  });
}

function hashOtp(phone, code, createdAt) {
  return createHmac('sha256', otpSecret).update(`${phone}:${code}:${createdAt}`).digest('hex');
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function takeRateLimit(key, limit, windowMs) {
  const now = Date.now();
  const recent = (requestLog.get(key) || []).filter(time => now - time < windowMs);
  if (recent.length >= limit) return false;
  recent.push(now);
  requestLog.set(key, recent);
  return true;
}

function currentUser(req) {
  const match = req.headers.authorization?.match(/^Bearer (.+)$/i);
  if (!match) return null;
  const tokenHash = hashToken(match[1]);
  return db.prepare(`SELECT users.id, users.phone FROM auth_sessions
    JOIN users ON users.id = auth_sessions.user_id
    WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ?`).get(tokenHash, Date.now()) || null;
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/health') {
    return json(res, 200, { ok: true, service: 'goride-api', database: 'sqlite' });
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    return json(res, 200, { googleMapsKey });
  }

  if (req.method === 'GET' && pathname === '/api/ride-types') {
    const rideTypes = db.prepare('SELECT id, name, icon, seats, eta_minutes AS etaMinutes, base_fare AS baseFare FROM ride_types WHERE enabled = 1 ORDER BY id').all();
    return json(res, 200, { rideTypes });
  }

  if (req.method === 'GET' && pathname === '/api/fare-quote') {
    const params = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams;
    const pickup = String(params.get('pickup') || '').trim();
    const destination = String(params.get('destination') || '').trim();
    const seats = Number(params.get('seats'));
    const rideTypeId = Number(params.get('rideTypeId'));
    if (!pickup || !destination || !Number.isInteger(seats)) return json(res, 400, { error: 'Pickup, destination, and vehicle seats are required.' });
    const quote = zoneFare(pickup, destination, seats, seats >= 7 ? 45 : 30, Number.isInteger(rideTypeId) ? rideTypeId : undefined);
    return json(res, 200, quote);
  }

  if (req.method === 'GET' && pathname === '/api/admin/ride-types') {
    const rideTypes = db.prepare('SELECT id, name, icon, seats, eta_minutes AS etaMinutes, base_fare AS baseFare, enabled FROM ride_types ORDER BY id').all();
    return json(res, 200, { rideTypes });
  }

  if (req.method === 'GET' && pathname === '/api/admin/fare-rules') {
    const rideTypes = db.prepare('SELECT id, name, icon, seats, base_fare AS baseFare FROM ride_types ORDER BY id').all();
    for (const rideType of rideTypes) ensureFareRules(rideType);
    const prices = db.prepare('SELECT route_key AS routeKey, ride_type_id AS rideTypeId, price FROM fare_rules').all();
    return json(res, 200, { routes: fareRoutes.map(([key, label]) => ({ key, label })), rideTypes, prices });
  }

  if (req.method === 'PATCH' && pathname === '/api/admin/fare-rules') {
    const body = await getBody(req);
    const routeKey = String(body.routeKey || '');
    const rideTypeId = Number(body.rideTypeId), price = Number(body.price);
    if (!fareRoutes.some(([key]) => key === routeKey) || !Number.isInteger(rideTypeId) || !Number.isFinite(price) || price <= 0 || price > 5000) return json(res, 400, { error: 'Enter a valid route, vehicle, and fare.' });
    const rideType = db.prepare('SELECT id, seats, base_fare AS baseFare FROM ride_types WHERE id = ?').get(rideTypeId);
    if (!rideType) return json(res, 404, { error: 'Ride type not found.' });
    ensureFareRules(rideType);
    db.prepare('UPDATE fare_rules SET price = ? WHERE route_key = ? AND ride_type_id = ?').run(price, routeKey, rideTypeId);
    if (routeKey === 'local') db.prepare('UPDATE ride_types SET base_fare = ? WHERE id = ?').run(price, rideTypeId);
    return json(res, 200, { routeKey, rideTypeId, price });
  }

  if (req.method === 'POST' && pathname === '/api/admin/ride-types') {
    const body = await getBody(req);
    const name = String(body.name || '').trim(), icon = String(body.icon || '').trim() || '🚗';
    const seats = Number(body.seats), etaMinutes = Number(body.etaMinutes), baseFare = Number(body.baseFare);
    if (name.length < 2 || name.length > 40 || icon.length > 24 || !Number.isInteger(seats) || seats < 1 || seats > 30 || !Number.isInteger(etaMinutes) || etaMinutes < 1 || etaMinutes > 180 || !Number.isFinite(baseFare) || baseFare <= 0 || baseFare > 1000) return json(res, 400, { error: 'Enter valid vehicle details.' });
    try {
      const result = db.prepare('INSERT INTO ride_types (name, icon, seats, eta_minutes, base_fare, enabled) VALUES (?, ?, ?, ?, ?, 1)').run(name, icon, seats, etaMinutes, baseFare);
      const rideType = db.prepare('SELECT id, name, icon, seats, eta_minutes AS etaMinutes, base_fare AS baseFare, enabled FROM ride_types WHERE id = ?').get(result.lastInsertRowid);
      ensureFareRules(rideType);
      return json(res, 201, { rideType });
    } catch { return json(res, 409, { error: 'A vehicle type with that name already exists.' }); }
  }

  const rideTypeMatch = pathname.match(/^\/api\/admin\/ride-types\/(\d+)$/);
  if (req.method === 'PATCH' && rideTypeMatch) {
    const body = await getBody(req);
    const icon = String(body.icon || '').trim() || '🚗';
    const seats = Number(body.seats), etaMinutes = Number(body.etaMinutes), baseFare = Number(body.baseFare);
    const enabled = body.enabled ? 1 : 0;
    if (icon.length > 24 || !Number.isInteger(seats) || seats < 1 || seats > 30 || !Number.isInteger(etaMinutes) || etaMinutes < 1 || etaMinutes > 180 || !Number.isFinite(baseFare) || baseFare <= 0 || baseFare > 1000) return json(res, 400, { error: 'Enter valid ride type details.' });
    const result = db.prepare('UPDATE ride_types SET icon = ?, seats = ?, eta_minutes = ?, base_fare = ?, enabled = ? WHERE id = ?').run(icon, seats, etaMinutes, baseFare, enabled, Number(rideTypeMatch[1]));
    if (!result.changes) return json(res, 404, { error: 'Ride type not found.' });
    db.prepare("UPDATE fare_rules SET price = ? WHERE route_key = 'local' AND ride_type_id = ?").run(baseFare, Number(rideTypeMatch[1]));
    const rideType = db.prepare('SELECT id, name, icon, seats, eta_minutes AS etaMinutes, base_fare AS baseFare, enabled FROM ride_types WHERE id = ?').get(Number(rideTypeMatch[1]));
    ensureFareRules(rideType);
    return json(res, 200, { rideType });
  }

  if (req.method === 'GET' && pathname === '/api/places/nearest') {
    const params = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams;
    const latitude = Number(params.get('lat'));
    const longitude = Number(params.get('lng'));
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return json(res, 400, { error: 'A valid map location is required.' });
    const place = db.prepare(`SELECT name, area, latitude, longitude,
      ((latitude - ?) * (latitude - ?) + (longitude - ?) * (longitude - ?)) AS distance
      FROM places ORDER BY distance LIMIT 1`).get(latitude, latitude, longitude, longitude);
    return json(res, 200, { place: place || null });
  }

  if (req.method === 'GET' && pathname === '/api/places') {
    const query = String(new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams.get('q') || '').trim();
    if (query.length < 2) return json(res, 200, { places: [] });
    const matches = db.prepare(`SELECT id, name, area, latitude, longitude FROM places
      WHERE name LIKE ? OR area LIKE ? ORDER BY name LIMIT 6`).all(`%${query}%`, `%${query}%`);
    return json(res, 200, { places: matches });
  }

  if (req.method === 'POST' && pathname === '/api/auth/request-otp') {
    const body = await getBody(req);
    const phone = String(body.phone || '').trim();
    if (!/^\d{7}$/.test(phone)) return json(res, 400, { error: 'Enter a valid 7-digit Maldives phone number.' });
    if (!takeRateLimit(`phone:${phone}`, 3, 10 * 60 * 1000)) return json(res, 429, { error: 'Too many code requests. Try again later.' });
    const now = Date.now();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    db.prepare('INSERT INTO otp_challenges (phone, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(phone, hashOtp(phone, code, now), now + otpLifetimeMs, now);
    const response = { ok: true, expiresInSeconds: otpLifetimeMs / 1000 };
    if (mode !== 'production') {
      response.demoOtp = code;
      console.info(`[GoRide development OTP] ${phone}: ${code}`);
    }
    return json(res, 200, response);
  }

  if (req.method === 'POST' && pathname === '/api/auth/verify-otp') {
    const body = await getBody(req);
    const phone = String(body.phone || '').trim();
    const code = String(body.otp || '').trim();
    if (!/^\d{7}$/.test(phone) || !/^\d{6}$/.test(code)) return json(res, 400, { error: 'Enter the phone number and 6-digit code.' });
    const challenge = db.prepare(`SELECT * FROM otp_challenges WHERE phone = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`).get(phone);
    if (!challenge || challenge.expires_at < Date.now() || challenge.attempts >= 5) return json(res, 400, { error: 'The code expired. Request a new one.' });
    const candidate = Buffer.from(hashOtp(phone, code, challenge.created_at));
    const expected = Buffer.from(challenge.code_hash);
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      db.prepare('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ?').run(challenge.id);
      return json(res, 400, { error: 'That code is incorrect. Try again.' });
    }
    db.prepare('UPDATE otp_challenges SET consumed_at = ? WHERE id = ?').run(Date.now(), challenge.id);
    const userResult = db.prepare(`INSERT INTO users (phone) VALUES (?) ON CONFLICT(phone) DO UPDATE SET phone = excluded.phone RETURNING id, phone`).get(phone);
    const sessionToken = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
      .run(userResult.id, hashToken(sessionToken), Date.now() + sessionLifetimeMs);
    return json(res, 200, { ok: true, token: sessionToken, user: { id: userResult.id, phone: userResult.phone } });
  }

  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const user = currentUser(req);
    if (!user) return json(res, 401, { error: 'Sign in to continue.' });
    return json(res, 200, { user });
  }

  if (req.method === 'GET' && pathname === '/api/admin/dashboard') {
    const customers = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    const rideCount = db.prepare('SELECT COUNT(*) AS count FROM rides').get().count;
    const requested = db.prepare(`SELECT COUNT(*) AS count FROM rides WHERE status = 'requested'`).get().count;
    const rides = db.prepare(`SELECT rides.id, users.phone, rides.pickup, rides.destination,
      rides.ride_type AS rideType, rides.estimated_fare AS estimatedFare, rides.status,
      rides.created_at AS createdAt FROM rides JOIN users ON users.id = rides.user_id
      ORDER BY rides.id DESC LIMIT 50`).all();
    return json(res, 200, { summary: { customers, rideCount, requested }, rides });
  }

  const adminRideMatch = pathname.match(/^\/api\/admin\/rides\/(\d+)\/status$/);
  if (req.method === 'PATCH' && adminRideMatch) {
    const body = await getBody(req);
    const status = String(body.status || '');
    const allowed = new Set(['requested', 'accepted', 'in_progress', 'completed', 'cancelled']);
    if (!allowed.has(status)) return json(res, 400, { error: 'Unsupported ride status.' });
    const result = db.prepare('UPDATE rides SET status = ? WHERE id = ?').run(status, Number(adminRideMatch[1]));
    if (!result.changes) return json(res, 404, { error: 'Ride not found.' });
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/rides') {
    const user = currentUser(req);
    if (!user) return json(res, 401, { error: 'Sign in to request a ride.' });
    if (req.method === 'GET') {
      const rides = db.prepare(`SELECT id, pickup, destination, ride_type AS rideType, estimated_fare AS estimatedFare, status, created_at AS createdAt FROM rides WHERE user_id = ? ORDER BY id DESC LIMIT 50`).all(user.id);
      return json(res, 200, { rides });
    }
    if (req.method === 'POST') {
      const body = await getBody(req);
      const pickup = String(body.pickup || '').trim().slice(0, 200);
      const destination = String(body.destination || '').trim().slice(0, 200);
      const rideType = String(body.rideType || '');
      if (!pickup || !destination) return json(res, 400, { error: 'Pickup and destination are required.' });
      const selectedType = db.prepare('SELECT id, name, seats, base_fare AS baseFare FROM ride_types WHERE name = ? AND enabled = 1').get(rideType);
      if (!selectedType) return json(res, 400, { error: 'Choose an available ride type.' });
      const quote = zoneFare(pickup, destination, selectedType.seats, selectedType.baseFare, selectedType.id);
      const result = db.prepare(`INSERT INTO rides (user_id, pickup, destination, ride_type, estimated_fare) VALUES (?, ?, ?, ?, ?)`).run(user.id, pickup, destination, rideType, quote.fare);
      const ride = db.prepare(`SELECT id, pickup, destination, ride_type AS rideType, estimated_fare AS estimatedFare, status, created_at AS createdAt FROM rides WHERE id = ?`).get(result.lastInsertRowid);
      return json(res, 201, { ride });
    }
  }
  return json(res, 404, { error: 'API route not found.' });
}

async function handle(req, res) {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  const tileMatch = pathname.match(/^\/map-tiles\/(\d{1,2})\/(\d+)\/(\d+)\.png$/);
  if (req.method === 'GET' && tileMatch) {
    const [, zoom, column, row] = tileMatch;
    if (Number(zoom) > 19) return json(res, 400, { error: 'Unsupported map zoom.' });
    try {
      const tile = await fetch(`https://tile.openstreetmap.org/${zoom}/${column}/${row}.png`, {
        headers: { 'user-agent': 'GoRide-local-prototype/0.1 (local development)' }
      });
      if (!tile.ok) return json(res, tile.status, { error: 'Map tile unavailable.' });
      const image = Buffer.from(await tile.arrayBuffer());
      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=86400',
        'access-control-allow-origin': 'same-origin'
      });
      return res.end(image);
    } catch (error) {
      console.error('Map tile error:', error);
      return json(res, 502, { error: 'Map tile unavailable.' });
    }
  }
  if (pathname.startsWith('/api/')) {
    try { return await handleApi(req, res, pathname); }
    catch (error) {
      console.error(error);
      return json(res, error.message === 'Request body must be valid JSON' ? 400 : 500, { error: error.message || 'Server error.' });
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
  const requested = pathname === '/' ? '/index.html' : pathname === '/admin' ? '/admin.html' : decodeURIComponent(pathname);
  const relative = normalize(requested).replace(/^([/\\]|\.\.(?:[/\\]|$))+/, '');
  if (relative.split(/[\\/]/).some(segment => segment.startsWith('.'))) return json(res, 404, { error: 'Not found.' });
  const file = join(root, relative);
  if (!file.startsWith(root)) return json(res, 403, { error: 'Forbidden.' });
  try {
    const content = await readFile(file);
    const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    if (req.method === 'HEAD') return res.end();
    res.end(content);
  } catch {
    json(res, 404, { error: 'Not found.' });
  }
}

createServer(handle).listen(port, '0.0.0.0', () => {
  console.info(`GoRide is running at http://127.0.0.1:${port}`);
  console.info(`Database: ${join(dataDir, 'goride.sqlite')}`);
  if (mode !== 'production') console.info('Development OTP mode is enabled; OTPs are logged to this terminal.');
});
