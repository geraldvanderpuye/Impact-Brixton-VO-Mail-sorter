const { google } = require('googleapis');
const { getAuthClient } = require('../auth');

// ── Contact list cache ────────────────────────────────────────────────────────
let contactsCache = null;
let cacheExpiry = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch all contacts with emails. Results are cached for 5 minutes.
 * Returns an array of { resourceName, displayName, givenName, familyName, org, email }.
 *
 * Contact structure used by this business:
 *   First name = person's name  (e.g. "Chris Jones")
 *   Last name  = company name   (e.g. "PLUCKY BAMBOO LTD")
 *   Company    = company name   (e.g. "PLUCKY BAMBOO LTD")
 */
async function listAllContacts() {
  const now = Date.now();
  if (contactsCache && now < cacheExpiry) return contactsCache;

  const auth = getAuthClient();
  if (!auth) throw new Error('Not authenticated');

  const people = google.people({ version: 'v1', auth });

  // Map a People API person object — email is optional (needed for sending, not for matching)
  function mapPerson(person) {
    const name  = person.names?.[0];
    return {
      resourceName: person.resourceName,
      displayName:  name?.displayName || '',
      givenName:    name?.givenName   || '',
      familyName:   name?.familyName  || '',
      org:          person.organizations?.[0]?.name || '',
      email:        person.emailAddresses?.[0]?.value || '',
      get name() { return this.displayName; },
    };
  }

  // Fetch ALL personal contacts, following pagination
  const fromConnections = [];
  let connPageToken;
  do {
    const connRes = await people.people.connections.list({
      resourceName: 'people/me',
      pageSize: 1000,
      personFields: 'names,emailAddresses,organizations',
      pageToken: connPageToken,
    });
    (connRes.data.connections || []).forEach((p) => {
      const mapped = mapPerson(p);
      if (mapped.displayName || mapped.org) fromConnections.push(mapped);
    });
    connPageToken = connRes.data.nextPageToken;
  } while (connPageToken);
  console.log(`[contacts] connections.list: ${fromConnections.length} found (${fromConnections.filter(c=>c.email).length} with email)`);

  // Log contact groups to help diagnose where customer contacts are stored
  try {
    const groupsRes = await people.contactGroups.list({ pageSize: 50 });
    const groups = (groupsRes.data.contactGroups || []).map((g) => `"${g.name}" (${g.memberCount || 0} members)`);
    console.log('[contacts] Contact groups:', groups.join(', '));
  } catch (e) {
    console.log('[contacts] Could not list contact groups:', e.message);
  }

  // Also fetch "Other contacts" (contacts the user has interacted with but not formally added)
  let fromOther = [];
  try {
    const otherRes = await people.otherContacts.list({
      pageSize: 1000,
      readMask: 'names,emailAddresses,organizations',
    });
    fromOther = (otherRes.data.otherContacts || []).map(mapPerson).filter(Boolean);
    console.log(`[contacts] otherContacts: ${fromOther.length} found`);
  } catch (e) {
    console.log('[contacts] otherContacts not available:', e.message);
  }

  // Also fetch Google Workspace Directory contacts (requires directory.readonly scope)
  let fromDirectory = [];
  try {
    let pageToken;
    do {
      const dirRes = await people.people.listDirectoryPeople({
        readMask: 'names,emailAddresses,organizations',
        sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT', 'DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE'],
        pageSize: 1000,
        pageToken,
      });
      const batch = (dirRes.data.people || []).map(mapPerson).filter(Boolean);
      fromDirectory.push(...batch);
      pageToken = dirRes.data.nextPageToken;
    } while (pageToken);
    console.log(`[contacts] Directory contacts: ${fromDirectory.length} found`);
  } catch (e) {
    console.log('[contacts] Directory contacts not available:', e.message);
  }

  // Merge, deduplicate by resourceName
  const seen = new Set();
  const contacts = [...fromConnections, ...fromOther, ...fromDirectory].filter((c) => {
    if (seen.has(c.resourceName)) return false;
    seen.add(c.resourceName);
    return true;
  });

  contactsCache = contacts;
  cacheExpiry   = now + CACHE_TTL;
  console.log(`[contacts] Cached ${contacts.length} contacts total (${fromConnections.length} connections, ${fromOther.length} other, ${fromDirectory.length} directory):`);
  contacts.forEach((c) => console.log(`  · "${c.displayName}" | family="${c.familyName}" | org="${c.org}" | email=${c.email}`));
  return contacts;
}

/** Invalidate cache (e.g. after a reassign) */
function invalidateContactsCache() {
  contactsCache = null;
  cacheExpiry   = 0;
}

// ── Text normalisation ────────────────────────────────────────────────────────
function normalise(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Significant words: length > 2, not a noise term */
const NOISE = new Set([
  'ltd', 'limited', 'llp', 'plc', 'inc', 'the', 'and', 'for', 'with',
  'please', 'write', 'changes', 'address', 'black', 'below', 'using',
  'impact', 'brixton', 'electric', 'lane', 'london', 'street', 'road',
  'house', 'companies', 'company', 'national', 'statistics', 'customs',
  'crown', 'cardiff', 'secretary', 'director', 'reference', 'number',
]);

function significantWords(text) {
  return normalise(text)
    .split(' ')
    .filter((w) => w.length > 2 && !NOISE.has(w));
}

/**
 * Score how well OCR text matches a contact.
 * Searches BOTH the extracted recipient block AND the full OCR text for clues.
 * Returns 0–100.
 *
 * Contact structure: givenName = person name, familyName = company name, org = company name.
 */
function scoreMatch(recipientText, contact, fullOcrText) {
  // Build a combined search corpus: extracted recipient block + full OCR text
  // Weight the recipient block more heavily by repeating it
  const searchCorpus   = [recipientText, recipientText, fullOcrText || ''].join(' ');
  const corpusNorm     = normalise(searchCorpus);
  const corpusNoSp     = corpusNorm.replace(/\s/g, '');

  let best = 0;

  // ── Company name matching (highest priority) ──────────────────────────────
  const companyTerms = [contact.familyName, contact.org]
    .map(normalise)
    .filter(Boolean);

  for (const term of companyTerms) {
    if (!term) continue;
    // Skip trivially short terms — they cause false positives via substring matching
    // (e.g. familyName="Do" matches "london" because "Do" ⊂ "lonDOn")
    if (term.length < 4) continue;
    const termNoSp = term.replace(/\s/g, '');

    // Exact substring in recipient block (most reliable)
    const recipientNorm = normalise(recipientText);
    if (recipientNorm.includes(term)) { best = Math.max(best, 100); continue; }

    // Exact substring anywhere in OCR text — but only if the term has meaningful words.
    // Terms made entirely of noise words (e.g. "impact brixton") will always hit the
    // address block and produce false positives.
    if (significantWords(term).length > 0 && corpusNorm.includes(term)) {
      best = Math.max(best, 85); continue;
    }

    // Match ignoring spaces (handles "DAGGERENDEAVOUR" vs "DAGGER ENDEAVOUR")
    // Requires: multi-word term (so single-word terms don't create cross-word false positives)
    //   AND at least one significant word (so all-NOISE terms like "impact brixton" don't
    //   match the VO address block that appears in every letter)
    if (term.includes(' ') && significantWords(term).length > 0 && termNoSp.length > 4 && corpusNoSp.includes(termNoSp)) {
      best = Math.max(best, 80); continue;
    }

    // Word-overlap score
    const termWords   = significantWords(term);
    const corpusWords = significantWords(searchCorpus);
    if (termWords.length === 0) continue;
    const hits = termWords.filter((w) => corpusWords.includes(w));
    if (hits.length > 0) {
      const score = (hits.length / termWords.length) * 70;
      best = Math.max(best, score);
    }
  }

  // ── Person first-name boost (givenName appears in OCR text) ──────────────
  // Adds confidence when the person's name (e.g. "Chris Jones") also appears in the letter
  if (best > 0 && contact.givenName) {
    const givenNorm   = normalise(contact.givenName);
    const givenWords  = significantWords(contact.givenName); // meaningful name words
    if (givenWords.length > 0) {
      const nameHits = givenWords.filter((w) => corpusNorm.includes(w));
      if (nameHits.length > 0) {
        // Boost score slightly — name match is supporting evidence, not primary
        best = Math.min(100, best + 5);
      }
    }
  }

  return best;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Real-time contact search — used by the ContactPicker UI.
 */
async function searchContacts(query) {
  if (!query || query.trim().length < 2) return [];

  const auth = getAuthClient();
  if (!auth) throw new Error('Not authenticated');

  const people = google.people({ version: 'v1', auth });

  try {
    const res = await people.people.searchContacts({
      query: query.trim(),
      readMask: 'names,emailAddresses,organizations',
      pageSize: 10,
    });

    return (res.data.results || [])
      .map((r) => {
        const person = r.person;
        const name   = person.names?.[0]?.displayName || person.organizations?.[0]?.name || '';
        const email  = person.emailAddresses?.[0]?.value || '';
        const org    = person.organizations?.[0]?.name || '';
        return { resourceName: person.resourceName, name, email, org };
      })
      .filter((c) => c.email);
  } catch (err) {
    console.error('Contacts search error:', err.message);
    return [];
  }
}

/**
 * Find the best matching contact for an OCR scan.
 * @param {string} recipientText  - Extracted recipient block (short, targeted)
 * @param {string} [fullOcrText]  - Full OCR text of the page (used for extra clues)
 * Returns the best match above a confidence threshold with an email, or null.
 */
async function findBestMatch(recipientText, fullOcrText) {
  if (!recipientText && !fullOcrText) return null;

  let contacts;
  try {
    contacts = await listAllContacts();
  } catch (err) {
    console.error('[contacts] Failed to list contacts:', err.message);
    return null;
  }

  if (contacts.length === 0) return null;

  let bestContact = null;
  let bestScore   = 0;

  for (const contact of contacts) {
    const score = scoreMatch(recipientText || '', contact, fullOcrText);
    if (score > bestScore) {
      bestScore   = score;
      bestContact = contact;
    }
  }

  // Require a reasonably confident match
  if (bestScore < 50) {
    console.log(`[contacts] No confident match (best score: ${bestScore.toFixed(0)})`);
    return null;
  }

  // Must have an email to be usable
  if (!bestContact.email) {
    console.log(`[contacts] Best match "${bestContact.displayName}" has no email — skipping`);
    return null;
  }

  console.log(`[contacts] Matched "${bestContact.displayName}" <${bestContact.email}> (score ${bestScore.toFixed(0)})`);
  return {
    resourceName: bestContact.resourceName,
    name:         bestContact.displayName,
    email:        bestContact.email,
    org:          bestContact.org,
  };
}

module.exports = { searchContacts, findBestMatch, listAllContacts, invalidateContactsCache };
