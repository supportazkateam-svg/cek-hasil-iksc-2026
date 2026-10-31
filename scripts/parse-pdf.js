#!/usr/bin/env node

/*
 * Usage:
 *   node scripts/parse-pdf.js ./hasil-kelas-5.pdf ./data/peserta-kelas5.json
 *   node scripts/parse-pdf.js ./hasil-kelas-5.pdf ./data/peserta-kelas5.json --force
 *
 * Review the printed totals and a sample of the output before publishing it.
 * PDF text extraction is not a substitute for a human check of an official result.
 */
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');

const args = process.argv.slice(2);
const flags = args.filter((arg) => arg.startsWith('--'));
const positional = args.filter((arg) => !arg.startsWith('--'));
const [inputPath, outputPath] = positional;
const validFlags = new Set(['--force', '--allow-gaps']);
const unknownFlags = flags.filter((flag) => !validFlags.has(flag));
const forceOverwrite = flags.includes('--force');
const allowGaps = flags.includes('--allow-gaps');

if (unknownFlags.length) {
  console.error(`Flag tidak dikenal: ${unknownFlags.join(', ')}`);
  process.exit(1);
}
if (!inputPath || !outputPath) {
  console.error('Usage: node scripts/parse-pdf.js <input.pdf> <output.json> [--force] [--allow-gaps]');
  process.exit(1);
}

function compact(value) {
  return String(value || '').replace(/[\u200B-\u200D\uFEFF\u2060]/g, '').replace(/\s+/g, ' ').trim();
}

function parseRows(text) {
  const HEADER_LINE = /^(no|nama siswa|id peserta|kelas|sekolah|hasil)$/i;
  const SKIP_HEADER = /^(pengumuman hasil|international kangaroo|iksc\s*20\d{2}|kelas\s+\d+|no\.?\s+nama)/i;
  const RECORD_START = /^\d+(\s|$)/;
  const ROW_REGEX = /^(\d+)\s+(.+?)\s+([A-Z][A-Z0-9]*-[A-Z0-9]{4,})\s+(\d{1,2})\s+(.+?)\s+(Gold\s+Medal|Silver\s+Medal|Bronze\s+Medal|Participant)$/i;

  const rows = [];
  let current = '';

  // Iterasi manual per baris, tanpa text.split() raksasa
  let start = 0;
  const len = text.length;
  while (start < len) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = len;
    const rawLine = text.slice(start, end);
    start = end + 1;

    // Bersihkan zero-width chars per baris (bukan seluruh teks)
    const line = rawLine
      .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!line) continue;

    if (HEADER_LINE.test(line)) continue;
    if (SKIP_HEADER.test(line)) continue;

    // Awal record baru: nomor bisa diikuti spasi ATAU akhir baris
    if (RECORD_START.test(line) && current) {
      const m = current.match(ROW_REGEX);
      if (m) {
        rows.push({
          no: Number.parseInt(m[1], 10),
          nama: m[2].replace(/\s+/g, ' ').trim(),
          id_peserta: m[3].toUpperCase(),
          kelas: m[4],
          sekolah: m[5].replace(/\s+/g, ' ').trim(),
          status: m[6].replace(/\b\w/g, (l) => l.toUpperCase())
        });
      }
      current = '';
    }

    current = current ? `${current} ${line}` : line;
  }

  // Flush record terakhir
  if (current) {
    const m = current.match(ROW_REGEX);
    if (m) {
      rows.push({
        no: Number.parseInt(m[1], 10),
        nama: m[2].replace(/\s+/g, ' ').trim(),
        id_peserta: m[3].toUpperCase(),
        kelas: m[4],
        sekolah: m[5].replace(/\s+/g, ' ').trim(),
        status: m[6].replace(/\b\w/g, (l) => l.toUpperCase())
      });
    }
  }

  return rows;
}

function getTier(status) {
  return String(status).toUpperCase().replace(' MEDAL', '_medal').replace(/\s+/g, '_').toLowerCase();
}

function analyseSequence(rows) {
  const nos = rows.map((row) => row.no).sort((a, b) => a - b);
  const duplicateNos = nos.filter((no, index) => index > 0 && no === nos[index - 1]);
  if (duplicateNos.length) {
    throw new Error(`Nomor urut duplikat: ${[...new Set(duplicateNos)].slice(0, 10).join(', ')}`);
  }

  const gaps = [];
  for (let index = 1; index < nos.length; index += 1) {
    const previous = nos[index - 1];
    const current = nos[index];
    if (current - previous > 1) gaps.push({ from: previous + 1, to: current - 1 });
  }
  return { minNo: nos[0], maxNo: nos[nos.length - 1], missingCount: gaps.reduce((total, gap) => total + gap.to - gap.from + 1, 0), gaps };
}

function getBackupPath(outputPath) {
  const stamp = Date.now();
  let attempt = 0;
  let backupPath;
  do {
    backupPath = `${outputPath}.bak-${stamp}${attempt ? `-${attempt}` : ''}`;
    attempt += 1;
  } while (fs.existsSync(backupPath));
  return backupPath;
}

function writeJsonAtomically(outputPath, output) {
  const tempPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(output, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tempPath, outputPath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch (_) { /* no temporary file to remove */ }
    throw error;
  }
}

async function main() {
  if (!fs.existsSync(inputPath)) throw new Error(`File PDF tidak ditemukan: ${inputPath}`);

  if (fs.existsSync(outputPath) && !forceOverwrite) {
    console.log(`\n🛑 File ${outputPath} sudah ada.`);
    console.log('   Data lama tidak diubah. Untuk menimpa, jalankan ulang dengan --force.');
    console.log(`   Contoh: node scripts/parse-pdf.js ${inputPath} ${outputPath} --force`);
    return;
  }

  console.log(`[1/4] Membaca file PDF: ${inputPath}...`);
  const buffer = fs.readFileSync(inputPath);
  const parser = new PDFParse({ data: buffer });
  console.log('[2/4] Mengekstrak teks (file besar dapat membutuhkan waktu)...');
  let parsed;
  try {
    parsed = await parser.getText();
  } finally {
    await parser.destroy();
  }

  console.log('[3/4] Memproses baris data...');
  const rows = parseRows(parsed.text);
  if (!rows.length) {
    throw new Error('Tidak ada baris yang terbaca. Periksa format PDF; tidak ada file keluaran yang dibuat.');
  }

  const ids = new Set();
  for (const row of rows) {
    if (ids.has(row.id_peserta)) throw new Error(`ID peserta duplikat: ${row.id_peserta}`);
    ids.add(row.id_peserta);
  }

  const sequence = analyseSequence(rows);
  if (sequence.missingCount) {
    console.warn(`\n⚠️  PERINGATAN GAP: Ada ${sequence.missingCount} nomor yang tidak terbaca.`);
    console.warn(`    Nomor terendah: ${sequence.minNo} | Nomor tertinggi: ${sequence.maxNo}`);
    console.warn(`    Total baris yang berhasil di-parse: ${rows.length}`);
    console.warn(`    Rentang hilang: ${sequence.gaps.slice(0, 5).map((gap) => gap.from === gap.to ? gap.from : `${gap.from}–${gap.to}`).join(', ')}${sequence.gaps.length > 5 ? ', …' : ''}`);
    if (!allowGaps) {
      throw new Error('Data dengan gap tidak ditulis. Periksa PDF atau jalankan ulang dengan --allow-gaps setelah ditinjau.');
    }
    console.warn('    --allow-gaps diterima; output tetap ditulis atas persetujuan eksplisit.');
  } else {
    console.log(`✅ Validasi nomor urut aman (${sequence.minNo} s/d ${sequence.maxNo}, tidak ada gap).`);
  }

  const counts = { gold_medal: 0, silver_medal: 0, bronze_medal: 0, participant: 0 };
  rows.forEach((row) => { counts[getTier(row.status)] += 1; });
  const output = {
    metadata: {
      nama_event: 'International Kangaroo Science Contest (IKSC) 2026',
      total_peserta: rows.length,
      rekap_medali: counts,
      generated_at: new Date().toISOString()
    },
    data: rows
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (fs.existsSync(outputPath)) {
    const backupPath = getBackupPath(outputPath);
    fs.copyFileSync(outputPath, backupPath, fs.constants.COPYFILE_EXCL);
    console.log(`💾 File lama dibackup ke: ${backupPath}`);
  }

  console.log(`[4/4] Menyimpan data ke ${outputPath}...`);
  writeJsonAtomically(outputPath, output);
  console.log(`\n🎉 Berhasil menulis ${rows.length} peserta.`);
  console.log('📊 Rekap Medali:', counts);
  console.log('Sampel:', rows.slice(0, 3));
}

main().catch((error) => {
  console.error(`Gagal memproses PDF: ${error.message}`);
  process.exit(1);
});
