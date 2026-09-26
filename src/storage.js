/**
 * Upload PDFs directly to Supabase Storage.
 * Bypasses Vercel's 4.5MB payload limit by going straight to Supabase.
 */

const { createClient } = require('@supabase/supabase-js');
const { fetchWithDeadline } = require('./runtime');

let supabase = null;

function getClient() {
  if (supabase) return supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for direct storage upload');
  }

  supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchWithDeadline },
  });
  return supabase;
}

/**
 * Upload a PDF buffer to Supabase Storage.
 * Returns the storage path on success, null on failure.
 */
async function uploadPdf(pdfBuffer, fileName) {
  const client = getClient();
  const safeName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
  const storagePath = `incoming/${Date.now()}-${safeName}`;

  const { error } = await client.storage
    .from('scanned-mail')
    .upload(storagePath, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: false,
    });

  if (error) {
    console.error('[storage] Upload failed:', error.message);
    return null;
  }

  console.log(`[storage] Uploaded: ${storagePath} (${(pdfBuffer.length / 1024).toFixed(0)}KB)`);
  return storagePath;
}

module.exports = { uploadPdf };
