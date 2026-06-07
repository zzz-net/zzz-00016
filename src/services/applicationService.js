const { getDb } = require('../db');
const { AppError } = require('../utils/response');

const STATUS = {
  PENDING_SUBMITTED: 'PENDING_SUBMITTED',
  DISPATCH_REVIEWED: 'DISPATCH_REVIEWED',
  SAFETY_APPROVED: 'SAFETY_APPROVED',
  PUBLISHED: 'PUBLISHED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED'
};

const STATUS_LABEL = {
  PENDING_SUBMITTED: '待调度复核',
  DISPATCH_REVIEWED: '待安全审批',
  SAFETY_APPROVED: '待发布',
  PUBLISHED: '已发布',
  REJECTED: '已驳回',
  CANCELLED: '已取消'
};

const VALID_TRANSITIONS = {
  PENDING_SUBMITTED: ['DISPATCH_REVIEWED', 'REJECTED', 'CANCELLED'],
  DISPATCH_REVIEWED: ['SAFETY_APPROVED', 'REJECTED', 'CANCELLED'],
  SAFETY_APPROVED: ['PUBLISHED', 'CANCELLED'],
  PUBLISHED: [],
  REJECTED: [],
  CANCELLED: []
};

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d;
}

function validateCreatePayload(body) {
  const errors = [];
  const { route_name, original_stops, new_stops, effective_start, effective_end, vehicle_id, reason } = body;

  if (!route_name || typeof route_name !== 'string' || !route_name.trim()) {
    errors.push('route_name 必填且为非空字符串');
  }
  if (!Array.isArray(original_stops) || original_stops.length === 0) {
    errors.push('original_stops 必填且为非空数组');
  }
  if (!Array.isArray(new_stops) || new_stops.length === 0) {
    errors.push('new_stops 必填且为非空数组');
  }
  const start = parseDate(effective_start);
  const end = parseDate(effective_end);
  if (!start) errors.push('effective_start 必填且为合法日期');
  if (!end) errors.push('effective_end 必填且为合法日期');
  if (start && end && start >= end) {
    errors.push('effective_start 必须早于 effective_end');
  }
  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    errors.push('reason 必填且为非空字符串');
  }
  if (vehicle_id !== undefined && vehicle_id !== null && (typeof vehicle_id !== 'string' || !vehicle_id.trim())) {
    errors.push('vehicle_id 若提供则必须为非空字符串');
  }
  return errors;
}

function createApplication(user, body) {
  const errors = validateCreatePayload(body);
  if (errors.length > 0) {
    throw new AppError('参数校验失败', 'VALIDATION_ERROR', 400, errors);
  }
  const db = getDb();
  const { route_name, original_stops, new_stops, effective_start, effective_end, vehicle_id, reason } = body;

  const info = db.prepare(`
    INSERT INTO applications
      (applicant_id, route_name, original_stops, new_stops, effective_start, effective_end, vehicle_id, reason, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    user.id,
    route_name.trim(),
    JSON.stringify(original_stops),
    JSON.stringify(new_stops),
    new Date(effective_start).toISOString(),
    new Date(effective_end).toISOString(),
    vehicle_id ? vehicle_id.trim() : null,
    reason.trim(),
    STATUS.PENDING_SUBMITTED
  );

  const id = info.lastInsertRowid;
  logApproval(db, id, user.id, 'SUBMIT', '提交改线申请', null, STATUS.PENDING_SUBMITTED);
  return getApplicationById(id);
}

function logApproval(db, applicationId, operatorId, action, comment, fromStatus, toStatus) {
  db.prepare(`
    INSERT INTO approval_logs (application_id, operator_id, action, comment, from_status, to_status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(applicationId, operatorId, action, comment || null, fromStatus || null, toStatus || null);
}

function checkTransition(fromStatus, toStatus) {
  const allowed = VALID_TRANSITIONS[fromStatus];
  if (!allowed) {
    throw new AppError(`未知状态: ${fromStatus}`, 'INVALID_STATUS', 400);
  }
  if (!allowed.includes(toStatus)) {
    throw new AppError(
      `状态流转非法: ${fromStatus} -> ${toStatus}，允许流转: ${allowed.join(', ') || '无'}`,
      'INVALID_TRANSITION',
      409,
      { from: fromStatus, to: toStatus, allowed }
    );
  }
}

function updateStatus(db, applicationId, operator, toStatus, action, comment, rejectReason = null) {
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(applicationId);
  if (!app) {
    throw new AppError(`申请 ${applicationId} 不存在`, 'NOT_FOUND', 404);
  }
  const fromStatus = app.status;
  checkTransition(fromStatus, toStatus);

  db.prepare(`
    UPDATE applications
    SET status = ?, updated_at = datetime('now','localtime'), reject_reason = ?
    WHERE id = ?
  `).run(toStatus, rejectReason, applicationId);

  logApproval(db, applicationId, operator.id, action, comment, fromStatus, toStatus);
  return getApplicationById(applicationId);
}

function dispatchReview(applicationId, operator, { approved, comment } = {}) {
  if (!approved) {
    return updateStatus(getDb(), applicationId, operator, STATUS.REJECTED, 'DISPATCH_REJECT', comment || '调度驳回', comment || '调度驳回');
  }
  return updateStatus(getDb(), applicationId, operator, STATUS.DISPATCH_REVIEWED, 'DISPATCH_APPROVE', comment || '调度复核通过');
}

function safetyApprove(applicationId, operator, { approved, comment } = {}) {
  if (!approved) {
    return updateStatus(getDb(), applicationId, operator, STATUS.REJECTED, 'SAFETY_REJECT', comment || '安全驳回', comment || '安全驳回');
  }
  return updateStatus(getDb(), applicationId, operator, STATUS.SAFETY_APPROVED, 'SAFETY_APPROVE', comment || '安全审批通过');
}

function detectConflicts(db, app) {
  const conflicts = [];
  const rows = db.prepare(`
    SELECT * FROM applications
    WHERE status = 'PUBLISHED'
      AND id != ?
      AND route_name = ?
      AND (
        (effective_start <= ? AND effective_end > ?)
        OR (effective_start < ? AND effective_end >= ?)
        OR (effective_start >= ? AND effective_end <= ?)
      )
  `).all(
    app.id,
    app.route_name,
    app.effective_end, app.effective_start,
    app.effective_end, app.effective_start,
    app.effective_start, app.effective_end
  );

  for (const other of rows) {
    let type = null;
    const details = [];
    details.push(`时间重叠: ${other.effective_start} ~ ${other.effective_end} 与本申请 ${app.effective_start} ~ ${app.effective_end} 重叠`);
    if (app.vehicle_id && other.vehicle_id && app.vehicle_id === other.vehicle_id) {
      type = 'BOTH';
      details.push(`车辆冲突: 两申请都使用车辆 ${app.vehicle_id}`);
    } else if (!type) {
      type = 'TIME';
    }
    conflicts.push({ type, details, conflicting_application_id: other.id, conflicting_route_name: other.route_name });
  }

  if (app.vehicle_id) {
    const vehicleConflictRows = db.prepare(`
      SELECT * FROM applications
      WHERE status = 'PUBLISHED'
        AND id != ?
        AND vehicle_id = ?
        AND (
          (effective_start <= ? AND effective_end > ?)
          OR (effective_start < ? AND effective_end >= ?)
          OR (effective_start >= ? AND effective_end <= ?)
        )
    `).all(
      app.id, app.vehicle_id,
      app.effective_end, app.effective_start,
      app.effective_end, app.effective_start,
      app.effective_start, app.effective_end
    );
    for (const other of vehicleConflictRows) {
      if (!conflicts.find(c => c.conflicting_application_id === other.id)) {
        conflicts.push({
          type: 'VEHICLE',
          details: [`车辆冲突: 申请 #${other.id} 在 ${other.effective_start} ~ ${other.effective_end} 使用车辆 ${app.vehicle_id}`],
          conflicting_application_id: other.id,
          conflicting_route_name: other.route_name
        });
      }
    }
  }
  return conflicts;
}

function publish(applicationId, operator) {
  const db = getDb();
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(applicationId);
  if (!app) {
    throw new AppError(`申请 ${applicationId} 不存在`, 'NOT_FOUND', 404);
  }
  if (app.status === STATUS.PUBLISHED) {
    return getApplicationById(applicationId);
  }
  if (app.status !== STATUS.SAFETY_APPROVED) {
    throw new AppError(
      `当前状态 ${app.status} 不能发布，必须先经过调度复核和安全审批`,
      'INVALID_TRANSITION',
      409,
      { currentStatus: app.status, requiredStatus: STATUS.SAFETY_APPROVED }
    );
  }
  const conflicts = detectConflicts(db, app);
  if (conflicts.length > 0) {
    for (const c of conflicts) {
      db.prepare(`
        INSERT INTO conflicts (application_id, conflict_type, conflict_detail, conflicting_application_id)
        VALUES (?, ?, ?, ?)
      `).run(applicationId, c.type, JSON.stringify(c.details), c.conflicting_application_id);
    }
    throw new AppError(
      `发布失败，检测到 ${conflicts.length} 个冲突`,
      'PUBLISH_CONFLICT',
      409,
      conflicts
    );
  }
  return updateStatus(db, applicationId, operator, STATUS.PUBLISHED, 'PUBLISH', '发布改线');
}

function serializeApplication(app, db) {
  if (!app) return null;
  const applicant = db.prepare('SELECT id, username, name, role FROM users WHERE id = ?').get(app.applicant_id);
  const logs = db.prepare(`
    SELECT al.id, al.action, al.comment, al.from_status, al.to_status, al.created_at,
           u.id as operator_id, u.name as operator_name, u.username as operator_username, u.role as operator_role
    FROM approval_logs al
    LEFT JOIN users u ON u.id = al.operator_id
    WHERE al.application_id = ?
    ORDER BY al.id ASC
  `).all(app.id);

  const history = logs.map(l => ({
    id: l.id,
    action: l.action,
    comment: l.comment,
    from_status: l.from_status,
    to_status: l.to_status,
    created_at: l.created_at,
    operator: {
      id: l.operator_id,
      name: l.operator_name,
      username: l.operator_username,
      role: l.operator_role
    }
  }));

  return {
    id: app.id,
    route_name: app.route_name,
    original_stops: JSON.parse(app.original_stops),
    new_stops: JSON.parse(app.new_stops),
    affected_stops: computeAffectedStops(JSON.parse(app.original_stops), JSON.parse(app.new_stops)),
    effective_start: app.effective_start,
    effective_end: app.effective_end,
    vehicle_id: app.vehicle_id,
    reason: app.reason,
    status: app.status,
    status_label: STATUS_LABEL[app.status] || app.status,
    reject_reason: app.reject_reason,
    applicant: applicant ? { id: applicant.id, name: applicant.name, username: applicant.username, role: applicant.role } : null,
    history,
    created_at: app.created_at,
    updated_at: app.updated_at
  };
}

function computeAffectedStops(original, newStops) {
  const origSet = new Set(original);
  const newSet = new Set(newStops);
  const removed = original.filter(s => !newSet.has(s));
  const added = newStops.filter(s => !origSet.has(s));
  return { removed, added, total_affected: removed.length + added.length };
}

function getApplicationById(id) {
  const db = getDb();
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  return serializeApplication(app, db);
}

function listApplications({ status, route_name, start_date, end_date, page = 1, page_size = 20 } = {}) {
  const db = getDb();
  const conditions = [];
  const params = [];
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (route_name) { conditions.push('route_name LIKE ?'); params.push(`%${route_name}%`); }
  if (start_date) { conditions.push('effective_end >= ?'); params.push(new Date(start_date).toISOString()); }
  if (end_date) { conditions.push('effective_start <= ?'); params.push(new Date(end_date).toISOString()); }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM applications ${where}`).get(...params).cnt;
  const offset = (Math.max(1, page) - 1) * Math.max(1, page_size);
  const rows = db.prepare(`
    SELECT * FROM applications ${where}
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(...params, Math.max(1, page_size), offset);

  return {
    total,
    page: Math.max(1, page),
    page_size: Math.max(1, page_size),
    items: rows.map(r => serializeApplication(r, db))
  };
}

function exportApplications({ format = 'json', route_name, start_date, end_date } = {}) {
  const db = getDb();
  const conditions = [];
  const params = [];
  if (route_name) { conditions.push('route_name LIKE ?'); params.push(`%${route_name}%`); }
  if (start_date) { conditions.push('effective_end >= ?'); params.push(new Date(start_date).toISOString()); }
  if (end_date) { conditions.push('effective_start <= ?'); params.push(new Date(end_date).toISOString()); }
  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const rows = db.prepare(`SELECT * FROM applications ${where} ORDER BY id ASC`).all(...params);
  const items = rows.map(r => serializeApplication(r, db));

  if (format === 'csv') {
    return toCSV(items);
  }
  return { count: items.length, items };
}

function toCSV(items) {
  const headers = [
    'ID', '线路', '原站点', '新站点', '移除站点', '新增站点',
    '生效开始', '生效结束', '车辆', '原因', '状态', '状态描述',
    '驳回原因', '申请人', '创建时间', '更新时间'
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
      it.id, it.route_name,
      escape(it.original_stops),
      escape(it.new_stops),
      escape(it.affected_stops.removed),
      escape(it.affected_stops.added),
      it.effective_start, it.effective_end,
      it.vehicle_id || '', it.reason,
      it.status, it.status_label,
      it.reject_reason || '',
      it.applicant ? it.applicant.name : '',
      it.created_at, it.updated_at
    ].map(escape).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

module.exports = {
  STATUS, STATUS_LABEL, VALID_TRANSITIONS,
  createApplication,
  dispatchReview,
  safetyApprove,
  publish,
  getApplicationById,
  listApplications,
  exportApplications,
  detectConflicts,
  parseDate
};
