const { fromBuffer } = require('pdf2pic');
const tesseract = require('node-tesseract-ocr');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Convert first page of PDF to PNG for Tesseract
async function pdfFirstPageToPng(pdfBuffer) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailscan-'));

  try {
    const convert = fromBuffer(pdfBuffer, {
      density: 250,
      format: 'png',
      width: 2480,
      height: 3508,
      saveFilename: 'page',
      savePath: tmpDir,
    });

    await convert(1, { responseType: 'image' });
    const pngPath = path.join(tmpDir, 'page.1.png');
    return { pngPath, tmpDir };
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

// Noise patterns — never part of a company name
const RECIPIENT_NOISE = /\b(secretary|please|write|changes|box|using|black|ink|below|registered|office|director|house|companies|to\s+your|name\s+and|address\s+in)\b/i;

// Extract recipient name from raw OCR text
function extractRecipient(ocrText) {
  const lines = ocrText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Strategy 1: "Electric Lane" anchor — scan backwards for company name
  const elRe = /electric\s+lane/i;
  const elIdx = lines.findIndex((l) => elRe.test(l));
  if (elIdx > 0) {
    const BUILDING_LINE = /^impact\s+brixton\b/i;
    let buildingFallback = null;

    for (let i = elIdx - 1; i >= 0 && i >= elIdx - 6; i--) {
      if (BUILDING_LINE.test(lines[i])) {
        buildingFallback = lines[i].trim();
        continue;
      }
      const cleaned = lines[i]
        .replace(/,?\s+[a-z][a-z ,]+$/, '')
        .replace(/\s*[-–]\s*\d{6,10}\b/, '')
        .replace(/\s+\d{6,10}$/, '')
        .trim();
      if (/^\d{1,4}[a-zA-Z]?$/.test(cleaned)) continue;
      if (cleaned.length > 2 && !RECIPIENT_NOISE.test(cleaned)) {
        return cleaned;
      }
    }
    if (buildingFallback) return buildingFallback;
  }

  // Strategy 2: company name + street on same line
  const fullText = ocrText.replace(/\n/g, ' ');
  const inlineRe = /([A-Z][A-Z\s&'.,-]{3,80}?)\s*,?\s*[a-z,\s]*\s+(?:\d{1,3}[A-Za-z]?\s+)?electric\s+lane/i;
  const m = fullText.match(inlineRe);
  if (m) {
    const raw = m[1]
      .replace(/^(the\s+secretary|secretary)\s*/i, '')
      .replace(/,?\s+[a-z][a-z ,]+$/, '')
      .trim();
    if (raw.length > 2 && !RECIPIENT_NOISE.test(raw)) return raw;
  }

  // Strategy 3: postcode anchor
  const postcodeRe = /\b([A-Z]{1,2}\d[\d A-Z]?\s*\d[A-Z]{2})\b/i;
  const postcodeIdx = lines.findIndex((l) => postcodeRe.test(l));
  if (postcodeIdx !== -1) {
    const block = lines.slice(Math.max(0, postcodeIdx - 4), postcodeIdx + 1);
    const voRe = /electric\s+lane|sw9|impact|brixton/i;
    const filtered = block.filter((l) => !voRe.test(l) && !RECIPIENT_NOISE.test(l));
    return (filtered.length > 0 ? filtered : block).join('\n');
  }

  // Fallback: first 4 lines
  return lines.slice(0, 4).join('\n');
}

async function processOcr(pdfBuffer) {
  const { pngPath, tmpDir } = await pdfFirstPageToPng(pdfBuffer);

  try {
    const ocrText = await tesseract.recognize(pngPath, {
      lang: 'eng',
      oem: 1,
      psm: 3,
    });

    const recipient = extractRecipient(ocrText);
    return { ocrText, recipient };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { processOcr, extractRecipient };
