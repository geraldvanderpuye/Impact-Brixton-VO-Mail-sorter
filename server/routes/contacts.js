const express = require('express');
const router = express.Router();
const { searchContacts, listAllContacts, invalidateContactsCache } = require('../services/contacts');

// GET /api/contacts/search?q=John+Smith
router.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) {
    return res.json([]);
  }

  try {
    const results = await searchContacts(q.trim());
    res.json(results);
  } catch (err) {
    console.error('Contact search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/contacts/all  — debug: list every contact we can see
router.get('/all', async (req, res) => {
  try {
    invalidateContactsCache();
    const contacts = await listAllContacts();
    res.json({
      total: contacts.length,
      withEmail: contacts.filter(c => c.email).length,
      contacts,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
