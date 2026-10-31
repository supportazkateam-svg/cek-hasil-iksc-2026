// api/cari.js
const fs = require('fs');
const path = require('path');

// Kunci rahasia untuk panitia melakukan pengujian (mendukung Environment Variable jika ada)
const SECRET_TEST_KEY = process.env.TEST_KEY || 'panitiaksnr2026';

// Batas data per halaman
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

// Cache data peserta di memori serverless untuk kecepatan akses
let DATA_PESERTA = null;

// ==========================================
// 1. FUNGSI CEK SAKLAR ON / OFF PENGUMUMAN
// ==========================================
function getSwitchStatus() {
  // Opsi A: Cek dari Environment Variable (jika disetel di hosting/Vercel)
  if (process.env.STATUS_RILIS !== undefined) {
    return process.env.STATUS_RILIS === 'true' || process.env.STATUS_RILIS === '1';
  }

  // Opsi B: Cek dari file config.json di root atau folder lokal
  const possibleConfigs = [
    path.join(__dirname, '..', 'config.json'), // Root direktori (1 level di atas api/)
    path.join(process.cwd(), 'config.json'),   // Root runtime direktori
    path.join(__dirname, 'config.json')        // Direktori lokal api/
  ];

  for (const configPath of possibleConfigs) {
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        return Boolean(config.is_active);
      } catch (e) {
        console.error('[Config Error]: Gagal membaca config.json:', e.message);
      }
    }
  }

  // Default jika belum ada pengaturan: sistem tetap terkunci (OFF)
  return false;
}

// ==========================================
// 2. FUNGSI MEMUAT DATA PESERTA
// ==========================================
function loadPesertaData() {
  // Hanya gunakan cache jika valid dan berisi data (mencegah bug cache kosong permanen)
  if (Array.isArray(DATA_PESERTA) && DATA_PESERTA.length > 0) {
    return DATA_PESERTA;
  }

  const possiblePaths = [
    path.join(__dirname, 'peserta.json'),           // 1. Tepat berdampingan di folder api/
    path.join(process.cwd(), 'api', 'peserta.json'),// 2. Dari root ke folder api/peserta.json
    path.join(process.cwd(), 'peserta.json'),       // 3. Cadangan di root
    path.join(process.cwd(), 'data', 'peserta.json')// 4. Cadangan di folder data/
  ];

  for (const filePath of possiblePaths) {
    if (fs.existsSync(filePath)) {
      try {
        const rawContent = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(rawContent);
        const records = Array.isArray(parsed) ? parsed : (parsed.data || []);
        
        if (records.length > 0) {
          DATA_PESERTA = records;
          console.log(`[Success] Berhasil memuat ${DATA_PESERTA.length} peserta dari: ${filePath}`);
          return DATA_PESERTA;
        }
      } catch (err) {
        console.error(`[Error JSON] Gagal membaca ${filePath}:`, err.message);
      }
    }
  }

  return [];
}

// ==========================================
// 3. FUNGSI NORMALISASI TEKS (BERSIH & KEBAL ANOMALI)
// ==========================================
function normalizeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    // Hapus karakter invisible unicode (zero-width space, word-joiner \u2060, BOM)
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
    // Hapus segala jenis petik tunggal/ganda (lurus, lengkung, backtick)
    .replace(/['’‘`"“”]/g, '')
    // Hapus tanda baca umum
    .replace(/[.,\/#!$%\^&\*;:{}=\-_~()]/g, '')
    // Satukan spasi berlebih
    .replace(/\s+/g, ' ')
    .trim();
}

// ==========================================
// 4. MAIN HANDLER (SERVERLESS FUNCTION)
// ==========================================
module.exports = (req, res) => {
  // Set Response Headers & CORS (Mendukung pemanggilan lintas origin)
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Tangani pre-flight request browser
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Hanya izinkan HTTP GET
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({
      success: false,
      message: 'Method Not Allowed. Hanya mendukung GET.'
    });
  }

  try {
    const { 
      mode = 'nama', 
      q = '', 
      status = 'semua', 
      test_key = '', 
      check_status = 'false',
      page = '1',
      limit = String(DEFAULT_LIMIT)
    } = req.query;

    const isSystemOn = getSwitchStatus();
    const isTesting = test_key === SECRET_TEST_KEY;

    // --- FITUR 1: CEK STATUS SAKLAR OLEH FRONTEND ---
    if (check_status === 'true') {
      return res.status(200).json({
        success: true,
        is_active: isSystemOn,
        is_test_mode: isTesting
      });
    }

    // --- FITUR 2: PROTEKSI PENGUMUMAN TERKUNCI ---
    if (!isSystemOn && !isTesting) {
      return res.status(403).json({
        success: false,
        status: 'locked',
        message: 'Pengumuman hasil belum dibuka oleh panitia. Silakan pantau halaman ini secara berkala.'
      });
    }

    // --- FITUR 3: VALIDASI & NORMALISASI QUERY ---
    const rawQuery = String(q).trim();
    if (/[<>{}[\]\\]/.test(rawQuery)) {
      return res.status(400).json({
        success: false,
        status: 'invalid_characters',
        message: 'Input mengandung karakter yang tidak diperbolehkan.'
      });
    }

    const queryNorm = normalizeText(rawQuery);

    // Validasi panjang dilakukan setelah normalisasi untuk mencegah celah dump data
    if (queryNorm.length < 2) {
      return res.status(400).json({
        success: false,
        status: 'invalid_query',
        message: 'Masukkan minimal 2 huruf atau angka yang valid untuk pencarian.'
      });
    }

    // Muat data peserta
    const daftarPeserta = loadPesertaData();
    if (!daftarPeserta || daftarPeserta.length === 0) {
      return res.status(500).json({
        success: false,
        status: 'data_unavailable',
        message: 'Database peserta belum tersedia di server. Hubungi administrator.'
      });
    }

    // --- FITUR 4: PROSES PENCARIAN & FILTERING ---
    let hasil = daftarPeserta.filter(p => {
      // 1. Filter Status Kelolosan
      if (status !== 'semua') {
        const isLolos = String(p.status || '').toUpperCase() === 'LOLOS';
        if (status === 'lolos' && !isLolos) return false;
        if (status === 'tidak_lolos' && isLolos) return false;
      }

      // 2. Filter Teks Berdasarkan Mode
      if (mode === 'sekolah') {
        return normalizeText(p.sekolah).includes(queryNorm);
      } else if (mode === 'wilayah') {
        return normalizeText(p.wilayah).includes(queryNorm);
      } else { 
        // Default mode = 'nama'
        return normalizeText(p.nama).includes(queryNorm);
      }
    });

    // --- FITUR 5: PENGURUTAN DATA ---
    hasil.sort((a, b) => {
      const aLolos = String(a.status || '').toUpperCase() === 'LOLOS';
      const bLolos = String(b.status || '').toUpperCase() === 'LOLOS';
      
      // Prioritaskan status LOLOS di urutan atas
      if (aLolos && !bLolos) return -1;
      if (!aLolos && bLolos) return 1;
      
      // Urutkan alfabetis nama
      return String(a.nama || '').localeCompare(String(b.nama || ''), 'id');
    });

    // --- FITUR 6: PAGINASI / LIMIT DATA ---
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(MAX_LIMIT, Math.max(1, parseInt(limit, 10) || DEFAULT_LIMIT));
    const startIndex = (pageNum - 1) * limitNum;
    const paginatedData = hasil.slice(startIndex, startIndex + limitNum);

    return res.status(200).json({
      success: true,
      status: 'success',
      mode: mode,
      query: rawQuery,
      total_found: hasil.length,
      page: pageNum,
      limit: limitNum,
      data: paginatedData
    });

  } catch (err) {
    console.error('[API Error]:', err);
    return res.status(500).json({
      success: false,
      message: 'Terjadi kendala teknis pada server.'
    });
  }
};
