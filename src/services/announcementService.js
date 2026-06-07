const { getDb } = require('../db');
const { AppError } = require('../utils/response');
const { log: auditLog } = require('../middleware/audit');

const STATUS_PUBLISHED = 'PUBLISHED';

function computeAffectedStops(original, newStops) {
  const origSet = new Set(original);
  const newSet = new Set(newStops);
  const removed = original.filter(s => !newSet.has(s));
  const added = newStops.filter(s => !origSet.has(s));
  return { removed, added, total_affected: removed.length + added.length };
}

function validateCreatePayload(body) {
  const errors = [];
  const { application_id, version, remark } = body;

  if (application_id === undefined || application_id === null) {
    errors.push('application_id 必填');
  } else if (!Number.isInteger(parseInt(application_id, 10)) || parseInt(application_id, 10) <= 0) {
    errors.push('application_id 必须为正整数');
  }

  if (version !== undefined && version !== null) {
    const v = parseInt(version, 10);
    if (isNaN(v) || v < 1) {
      errors.push('version 若提供则必须为 >= 1 的整数');
    }
  }

  if (remark !== undefined && remark !== null && typeof remark !== 'string') {
    errors.push('remark 若提供则必须为字符串');
  }

  return errors;
}

function getNextVersion(db, applicationId) {
  const row = db.prepare('SELECT MAX(version) as max_v FROM announcements WHERE application_id = ?').get(applicationId);
  return (row && row.max_v ? row.max_v : 0) + 1;
}

function serializeAnnouncement(row, db, { isPrivileged, viewerId } = {}) {
  if (!row) return null;

  const creator = db.prepare('SELECT id, name FROM users WHERE id = ?').get(row.created_by);
  const application = db.prepare('SELECT applicant_id FROM applications WHERE id = ?').get(row.application_id);

  const result = {
    id: row.id,
    application_id: row.application_id,
    version: row.version,
    route_name: row.route_name,
    affected_stops: JSON.parse(row.affected_stops),
    effective_start: row.effective_start,
    effective_end: row.effective_end,
    remark: row.remark,
    created_at: row.created_at
  };

  if (isPrivileged) {
    result.created_by = creator ? { id: creator.id, name: creator.name } : null;
    result.applicant_id = application ? application.applicant_id : null;
  } else if (viewerId !== undefined && viewerId !== null) {
    result.created_by = creator ? { name: creator.name } : null;
  }

  return result;
}

function summarizeAnnouncement(row) {
  return {
    id: row.id,
    application_id: row.application_id,
    version: row.version,
    route_name: row.route_name,
    effective_start: row.effective_start,
    effective_end: row.effective_end,
    created_at: row.created_at
  };
}

function createAnnouncement(operator, body) {
  const errors = validateCreatePayload(body);
  if (errors.length > 0) {
    throw new AppError('参数校验失败', 'VALIDATION_ERROR', 400, errors);
  }

  const db = getDb();
  const applicationId = parseInt(body.application_id, 10);
  const specifiedVersion = body.version !== undefined && body.version !== null
    ? parseInt(body.version, 10)
    : null;
  const remark = body.remark ? body.remark.trim() : null;

  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(applicationId);
  if (!app) {
    throw new AppError(`申请 ${applicationId} 不存在`, 'NOT_FOUND', 404);
  }
  if (app.status !== STATUS_PUBLISHED) {
    throw new AppError(
      `仅已发布(PUBLISHED)的申请可生成公告，当前状态: ${app.status}`,
      'INVALID_STATUS',
      409,
      { application_id: applicationId, current_status: app.status }
    );
  }

  const version = specifiedVersion !== null ? specifiedVersion : getNextVersion(db, applicationId);

  const existing = db.prepare(
    'SELECT * FROM announcements WHERE application_id = ? AND version = ?'
  ).get(applicationId, version);

  if (existing) {
    throw new AppError(
      `申请 #${applicationId} 的 v${version} 版公告已存在，不能重复生成`,
      'ANNOUNCEMENT_DUPLICATE',
      409,
      { existing: summarizeAnnouncement(existing) }
    );
  }

  const originalStops = JSON.parse(app.original_stops || '[]');
  const newStops = JSON.parse(app.new_stops || '[]');
  const affectedStops = computeAffectedStops(originalStops, newStops);

  const info = db.prepare(`
    INSERT INTO announcements
      (application_id, version, route_name, affected_stops, effective_start, effective_end, remark, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    applicationId,
    version,
    app.route_name,
    JSON.stringify(affectedStops),
    app.effective_start,
    app.effective_end,
    remark,
    operator.id
  );

  const id = info.lastInsertRowid;
  const row = db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);

  auditLog('ANNOUNCEMENT_CREATED', {
    user: operator,
    resource: '/api/announcements',
    resourceId: id,
    detail: {
      announcement_id: id,
      application_id: applicationId,
      version,
      route_name: app.route_name
    }
  });

  return serializeAnnouncement(row, db, { isPrivileged: true });
}

function isPrivilegedUser(user) {
  return user && (user.role === 'admin' || user.role === 'dispatcher' || user.role === 'safety');
}

function getAnnouncementById(id, user) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
  if (!row) {
    throw new AppError(`公告 ${id} 不存在`, 'NOT_FOUND', 404);
  }

  const privileged = isPrivilegedUser(user);
  if (!privileged) {
    const app = db.prepare('SELECT applicant_id FROM applications WHERE id = ?').get(row.application_id);
    if (!app || app.applicant_id !== user.id) {
      throw new AppError(
        '无权查看该公告，普通老师仅能查看本人提交申请相关的公告',
        'PERMISSION_DENIED',
        403,
        { announcement_id: id }
      );
    }
  }

  return serializeAnnouncement(row, db, { isPrivileged: privileged, viewerId: user ? user.id : null });
}

function listAnnouncements(user, { route_name, start_date, end_date, page = 1, page_size = 20 } = {}) {
  const db = getDb();
  const privileged = isPrivilegedUser(user);
  const conditions = [];
  const params = [];
  const appliedFilters = {};

  if (!privileged) {
    conditions.push(
      'a.application_id IN (SELECT id FROM applications WHERE applicant_id = ?)'
    );
    params.push(user.id);
    appliedFilters.scope = 'teacher: 仅本人申请相关公告';
  }

  if (route_name) {
    conditions.push('a.route_name LIKE ?');
    params.push(`%${route_name}%`);
    appliedFilters.route_name = route_name;
  }
  if (start_date) {
    conditions.push('a.effective_end >= ?');
    params.push(new Date(start_date).toISOString());
    appliedFilters.start_date = start_date;
  }
  if (end_date) {
    conditions.push('a.effective_start <= ?');
    params.push(new Date(end_date).toISOString());
    appliedFilters.end_date = end_date;
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM announcements a ${where}`).get(...params).cnt;
  const offset = (Math.max(1, page) - 1) * Math.max(1, page_size);
  const rows = db.prepare(`
    SELECT a.* FROM announcements a ${where}
    ORDER BY a.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, Math.max(1, page_size), offset);

  return {
    total,
    page: Math.max(1, page),
    page_size: Math.max(1, page_size),
    filters: appliedFilters,
    items: rows.map(r => serializeAnnouncement(r, db, { isPrivileged: privileged, viewerId: user ? user.id : null }))
  };
}

function listAnnouncementsByApplication(applicationId, user) {
  const db = getDb();
  const app = db.prepare('SELECT applicant_id, status FROM applications WHERE id = ?').get(applicationId);
  if (!app) {
    throw new AppError(`申请 ${applicationId} 不存在`, 'NOT_FOUND', 404);
  }

  const privileged = isPrivilegedUser(user);
  if (!privileged && app.applicant_id !== user.id) {
    throw new AppError(
      '无权查看该申请的公告，普通老师仅能查看本人申请相关公告',
      'PERMISSION_DENIED',
      403,
      { application_id: applicationId }
    );
  }

  const rows = db.prepare(
    'SELECT * FROM announcements WHERE application_id = ? ORDER BY version ASC'
  ).all(applicationId);

  return {
    application_id: applicationId,
    total: rows.length,
    items: rows.map(r => serializeAnnouncement(r, db, { isPrivileged: privileged, viewerId: user ? user.id : null }))
  };
}

function toCSV(items) {
  const headers = [
    'ID', '申请ID', '版本', '线路', '移除站点', '新增站点',
    '影响站点数', '生效开始', '生效结束', '备注', '发布时间'
  ];
  const escape = (val) => {
    if (val === null || val === undefined) return '';
    const s = Array.isArray(val) ? JSON.stringify(val) : String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const lines = [headers.join(',')];
  for (const it of items) {
    lines.push([
      it.id, it.application_id, it.version, it.route_name,
      escape(it.affected_stops.removed),
      escape(it.affected_stops.added),
      it.affected_stops.total_affected,
      it.effective_start, it.effective_end,
      it.remark || '',
      it.created_at
    ].map(escape).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

function exportAnnouncements(user, { format = 'json', route_name, start_date, end_date } = {}) {
  const db = getDb();
  const privileged = isPrivilegedUser(user);
  const conditions = [];
  const params = [];
  const filters = {};

  if (!privileged) {
    conditions.push(
      'a.application_id IN (SELECT id FROM applications WHERE applicant_id = ?)'
    );
    params.push(user.id);
    filters.scope_note = '普通老师默认仅导出本人申请相关公告';
  }

  if (route_name) {
    conditions.push('a.route_name LIKE ?');
    params.push(`%${route_name}%`);
    filters.route_name = route_name;
  }
  if (start_date) {
    conditions.push('a.effective_end >= ?');
    params.push(new Date(start_date).toISOString());
    filters.start_date = start_date;
  }
  if (end_date) {
    conditions.push('a.effective_start <= ?');
    params.push(new Date(end_date).toISOString());
    filters.end_date = end_date;
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const rows = db.prepare(`SELECT a.* FROM announcements a ${where} ORDER BY a.id ASC`).all(...params);
  const items = rows.map(r => serializeAnnouncement(r, db, { isPrivileged: privileged, viewerId: user ? user.id : null }));

  if (format === 'csv') {
    return { csv: toCSV(items), count: items.length, filters };
  }

  return {
    count: items.length,
    items,
    filters,
    filter_summary: buildFilterSummary(filters, user)
  };
}

function buildFilterSummary(filters, user) {
  const parts = [];
  if (filters.route_name) parts.push(`线路含"${filters.route_name}"`);
  if (filters.start_date) parts.push(`生效结束>=${filters.start_date}`);
  if (filters.end_date) parts.push(`生效开始<=${filters.end_date}`);
  if (filters.scope_note) parts.push(filters.scope_note);
  if (user) parts.push(`操作人=${user.name}(id=${user.id},role=${user.role})`);
  return parts.join('; ') || '无筛选条件';
}

module.exports = {
  createAnnouncement,
  getAnnouncementById,
  listAnnouncements,
  listAnnouncementsByApplication,
  exportAnnouncements
};
