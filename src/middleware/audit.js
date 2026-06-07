const { getDb } = require('../db');

function log(action, { user = null, resource = null, resourceId = null, detail = null, ip = null } = {}) {
  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO audit_logs (user_id, action, resource, resource_id, detail, ip)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      user ? user.id : null,
      action,
      resource,
      resourceId,
      detail ? JSON.stringify(detail) : null,
      ip
    );
  } catch (err) {
    console.error('[Audit Log Error]', err);
  }
}

function audit(action, resourceExtractor = null) {
  return (req, _res, next) => {
    try {
      const resourceId = resourceExtractor ? resourceExtractor(req) : null;
      log(action, {
        user: req.user || null,
        resource: req.baseUrl + req.path,
        resourceId,
        detail: { method: req.method, body: req.body, params: req.params, query: req.query },
        ip: req.ip
      });
    } catch (err) {
      console.error('[Audit Middleware Error]', err);
    }
    next();
  };
}

module.exports = { log, audit };
