const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const RL_WINDOW_SECONDS = 60;
const RL_MAX_REQUESTS = 30;
const VALID_MODES = new Set(['nama', 'sekolah', 'id']);
const VALID_STATUSES = new Set(['semua', 'medali', 'gold', 'silver', 'bronze', 'participant']);

let cachedData = null;
let redis = null;
const localRateLimits = new Map();

// Redis is optional locally, but required in production if rate limiting is desired.
try {
  const { Redis } = require('@upstash/redis');
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = Redis.fromEnv();
  }
} catch (_) {
  // Keep local development dependency-free; requests are still validated and capped.
}

function getSwitchStatus() {
  if (process.env.STATUS_RILIS !== undefined) return /^(true|1)$/i.test(process.env.STATUS_RILIS);

  // config.json is a local-development fallback only. Production should set STATUS_RILIS.
  try {
    return Boolean(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')).is_active);
  } catch (_) {
    return false;
  }
}

function secureEqual(input, secret) {
  if (!secret || !input) return false;
  const inputBuffer = Buffer.from(String(input));
  const secretBuffer = Buffer.from(String(secret));
  return inputBuffer.length === secretBuffer.length && crypto.timingSafeEqual(inputBuffer, secretBuffer);
}

function isTesting(req) {
  // Prefer a header so the secret does not become part of browser history or referrer logs.
  const suppliedKey = req.headers['x-test-key'] || '';
  return secureEqual(suppliedKey, process.env.TEST_KEY);
}

function readJson(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const records = Array.isArray(parsed) ? parsed : parsed.data;
    return Array.isArray(records) ? records : [];
  } catch (error) {
    console.error(`[Data Error] ${path.basename(filePath)}: ${error.message}`);
    return [];
  }
}

function loadPesertaData() {
  if (cachedData) return cachedData;

  const root = path.join(__dirname, '..');
  const ikscRecords = [
    path.join(root, 'data', 'peserta-kelas5.json'),
    path.join(root, 'data', 'peserta-kelas6.json')
  ].flatMap(readJson);

  // A legacy KSNR file exists in this repository, but it must never be presented
  // as IKSC results. It can be enabled explicitly for local migration checks only.
  cachedData = ikscRecords.length > 0
    ? ikscRecords
    : (process.env.ALLOW_LEGACY_DATA === 'true'
      ? readJson(path.join(root, 'api', 'peserta.json'))
      : []);
  return cachedData;
}

function normalizeText(value) {
  return String(value ?? '')
    .toLocaleLowerCase('id-ID')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
    .replace(/['’‘`"“”]/g, '')
    .replace(/[.,/#!$%^&*;:{}=\-_~()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getTier(status) {
  const normalized = String(status || '').toUpperCase();
  if (normalized.includes('GOLD')) return 'gold';
  if (normalized.includes('SILVER')) return 'silver';
  if (normalized.includes('BRONZE')) return 'bronze';
  return 'participant';
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return (Array.isArray(forwarded) ? forwarded[0] : String(forwarded || '').split(',')[0]).trim() || 'unknown';
}

async function isWithinRateLimit(ip) {
  if (!redis) {
    // Local fallback protects development and a warm single instance. Upstash remains
    // necessary in Vercel because individual serverless instances do not share memory.
    const now = Date.now();
    const state = localRateLimits.get(ip);
    if (!state || now - state.startedAt >= RL_WINDOW_SECONDS * 1000) {
      localRateLimits.set(ip, { startedAt: now, count: 1 });
      return true;
    }
    state.count += 1;
    return state.count <= RL_MAX_REQUESTS;
  }
  try {
    const key = `iksc:search:${ip}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, RL_WINDOW_SECONDS);
    return count <= RL_MAX_REQUESTS;
  } catch (error) {
    console.error(`[Rate Limit Error] ${error.message}`);
    return false;
  }
}

function matchesStatus(record, status) {
  const tier = getTier(record.status);
  if (status === 'semua') return true;
  if (status === 'medali') return tier !== 'participant';
  return tier === status;
}

function publicRecord(record) {
  const tier = getTier(record.status);
  return {
    no: record.no,
    nama: record.nama,
    id_peserta: record.id_peserta,
    kelas: record.kelas,
    sekolah: record.sekolah,
    status: record.status,
    tier,
    is_winner: tier !== 'participant'
  };
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ success: false, message: 'Hanya metode GET yang didukung.' });
  }

  try {
    const query = req.query || {};
    const mode = String(query.mode || 'nama').toLowerCase();
    const status = String(query.status || 'semua').toLowerCase();
    const testing = isTesting(req);
    const active = getSwitchStatus();

    if (query.check_status === 'true') {
      return res.status(200).json({ success: true, is_active: active, is_test_mode: testing });
    }
    if (!active && !testing) {
      return res.status(403).json({ success: false, status: 'locked', message: 'Pengumuman belum dibuka.' });
    }
    if (!testing && !(await isWithinRateLimit(getClientIp(req)))) {
      return res.status(429).json({ success: false, status: 'rate_limited', message: 'Terlalu banyak pencarian. Silakan coba lagi satu menit lagi.' });
    }
    if (!VALID_MODES.has(mode) || !VALID_STATUSES.has(status)) {
      return res.status(400).json({ success: false, message: 'Parameter pencarian tidak valid.' });
    }

    const rawQuery = String(query.q || '').trim();
    const normalizedQuery = normalizeText(rawQuery);
    if (normalizedQuery.length < 3) {
      return res.status(400).json({ success: false, status: 'invalid_query', message: 'Masukkan minimal 3 karakter yang valid.' });
    }

    const records = loadPesertaData();
    if (!records.length) {
      return res.status(503).json({ success: false, status: 'data_unavailable', message: 'Data hasil belum tersedia di server.' });
    }

    const matches = records.filter((record) => {
      const match = mode === 'id'
        ? normalizeText(record.id_peserta) === normalizedQuery
        : normalizeText(record[mode]).includes(normalizedQuery);
      return match && matchesStatus(record, status);
    }).sort((a, b) => {
      const rank = { gold: 4, silver: 3, bronze: 2, participant: 1 };
      const difference = rank[getTier(b.status)] - rank[getTier(a.status)];
      return difference || String(a.nama || '').localeCompare(String(b.nama || ''), 'id-ID');
    });

    const requestedLimit = Number.parseInt(query.limit, 10);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_LIMIT));
    return res.status(200).json({
      success: true,
      mode,
      total_found: matches.length,
      data: matches.slice(0, limit).map(publicRecord)
    });
  } catch (error) {
    console.error(`[API Error] ${error.message}`);
    return res.status(500).json({ success: false, message: 'Terjadi kendala teknis pada server.' });
  }
};
