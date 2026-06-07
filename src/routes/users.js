const express = require('express');
const { auth } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { success } = require('../utils/response');
const { getDb } = require('../db');

const router = express.Router();

router.get('/me', auth, audit('USER_ME'), (req, res) => {
  success(res, req.user);
});

router.get('/', auth, audit('USER_LIST'), (_req, res, next) => {
  try {
    const db = getDb();
    const users = db.prepare('SELECT id, username, name, role, created_at FROM users ORDER BY id ASC').all();
    success(res, { total: users.length, items: users });
  } catch (err) { next(err); }
});

module.exports = router;
