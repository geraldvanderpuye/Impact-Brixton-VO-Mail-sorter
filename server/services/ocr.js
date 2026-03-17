const { fromBuffer } = require('pdf2pic');
const tesseract = require('node-tesseract-ocr');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Convert first page of PDF buffer to PNG file path (Tesseract needs a file path)
async function pdfFirstPageToPng(pdfBuffer) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vomail-'));

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

    // pdf2pic saves as page.1.png
    const pngPath = path.join(tmpDir, 'page.1.png');
    return { pngPath, tmpDir };
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

// Words/phrases that are never part of a company name
const RECIPIENT_NOISE = /\b(secretary|please|write|changes|box|using|black|ink|below|registered|office|director|house|companies|to\s+your|name\s+and|address\s+in)\b/i;

// Extract recipient block from raw OCR text heuristically.
// Strategy: anchor on "Electric Lane" (the virtual office street) and extract
// the company name from the line(s) immediately before it.
function extractRecipient(ocrText) {
  const lines = ocrText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // ── Strategy 1: "Electric Lane" appears on its own line ──────────────────
  const elRe = /electric\s+lane/i;
  const elIdx = lines.findIndex((l) => elRe.test(l));
  if (elIdx > 0) {
    // "Impact Brixton" is the building name that appears between the company name
    // and the street address — e.g. "RNU CONSTRUCT LTD / Impact Brixton / 17a Electric Lane".
    // Skip it in the primary scan but save it as a fallback: if nothing is found above it,
    // Impact Brixton is itself the recipient (e.g. letters addressed to the IB team).
    const BUILDING_LINE = /^impact\s+brixton\b/i;
    let buildingFallback = null;

    // Scan backwards from the street line to find the company name line
    for (let i = elIdx - 1; i >= 0 && i >= elIdx - 6; i--) {
      if (BUILDING_LINE.test(lines[i])) {
        buildingFallback = lines[i].trim();
        continue; // keep scanning upward for the actual company name
      }
      // Strip trailing lowercase junk and registration numbers
      const cleaned = lines[i]
        .replace(/,?\s+[a-z][a-z ,]+$/, '')      // e.g. "PLUCKY BAMBOO LTD below, using black ink"
        .replace(/\s*[-–]\s*\d{6,10}\b/, '')      // e.g. "DAGGERENDEAVOUR LIMITED - 14516099"
        .replace(/\s+\d{6,10}$/, '')              // e.g. "THE STUDENT VIEW 09408293"
        .trim();
      // Skip bare house numbers (e.g. "17a", "15A") — these are street numbers, not names
      if (/^\d{1,4}[a-zA-Z]?$/.test(cleaned)) continue;
      if (cleaned.length > 2 && !RECIPIENT_NOISE.test(cleaned)) {
        return cleaned;
      }
    }
    // Nothing found above the building name line — Impact Brixton is itself the recipient
    if (buildingFallback) return buildingFallback;
  }

  // ── Strategy 2: company name + street on same OCR line ───────────────────
  // e.g. "PLUCKY BAMBOO LTD below, using black ink 17A ELECTRIC LANE LONDON SW9 8LA"
  const fullText = ocrText.replace(/\n/g, ' ');
  const inlineRe = /([A-Z][A-Z\s&'.,-]{3,80}?)\s*,?\s*[a-z,\s]*\s+(?:\d{1,3}[A-Za-z]?\s+)?electric\s+lane/i;
  const m = fullText.match(inlineRe);
  if (m) {
    // Strip leading salutations and trailing lowercase text from what we captured
    const raw = m[1]
      .replace(/^(the\s+secretary|secretary)\s*/i, '')
      .replace(/,?\s+[a-z][a-z ,]+$/, '')
      .trim();
    if (raw.length > 2 && !RECIPIENT_NOISE.test(raw)) return raw;
  }

  // ── Strategy 3: postcode anchor (original, but filter out VO address lines) ─
  const postcodeRe = /\b([A-Z]{1,2}\d[\d A-Z]?\s*\d[A-Z]{2})\b/i;
  const postcodeIdx = lines.findIndex((l) => postcodeRe.test(l));
  if (postcodeIdx !== -1) {
    const block = lines.slice(Math.max(0, postcodeIdx - 4), postcodeIdx + 1);
    const voRe = /electric\s+lane|sw9|impact|brixton/i;
    const filtered = block.filter((l) => !voRe.test(l) && !RECIPIENT_NOISE.test(l));
    return (filtered.length > 0 ? filtered : block).join('\n');
  }

  // ── Fallback: first 4 non-empty lines ────────────────────────────────────
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
