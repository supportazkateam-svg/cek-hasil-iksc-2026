#!/usr/bin/env node

/*
 * Usage:
 *   node scripts/parse-pdf.js ./hasil-kelas-5.pdf ./data/peserta-kelas5.json
 *
 * Review the printed totals and a sample of the output before publishing it.
 * PDF text extraction is not a substitute for a human check of an official result.
 */
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error('Usage: node scripts/parse-pdf.js <input.pdf> <output.json>');
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

async function main() {
  const buffer = fs.readFileSync(inputPath);
  const parser = new PDFParse({ data: buffer });
  const parsed = await parser.getText();
  await parser.destroy();

  const rows = parseRows(parsed.text);
  if (!rows.length) {
    throw new Error('Tidak ada baris yang terbaca. Periksa format PDF; tidak ada file keluaran yang dibuat.');
  }

  const ids = new Set();
  for (const row of rows) {
    if (ids.has(row.id_peserta)) throw new Error(`ID peserta duplikat: ${row.id_peserta}`);
    ids.add(row.id_peserta);
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
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Berhasil menulis ${rows.length} peserta ke ${outputPath}.`);
  console.log('Rekap:', counts);
  console.log('Sampel:', rows.slice(0, 3));
}

main().catch((error) => {
  console.error(`Gagal memproses PDF: ${error.message}`);
  process.exit(1);
});
