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

function updateStatus(db, applicationId, operator, toStatus, action, comment, { rejectReason = null, cancelRemark = null } = {}) {
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(applicationId);
  if (!app) {
    throw new AppError(`申请 ${applicationId} 不存在`, 'NOT_FOUND', 404);
  }
  const fromStatus = app.status;
  checkTransition(fromStatus, toStatus);

  db.prepare(`
    UPDATE applications
    SET status = ?, updated_at = datetime('now','localtime'), reject_reason = ?, cancel_remark = ?
    WHERE id = ?
  `).run(toStatus, rejectReason, cancelRemark, applicationId);

  logApproval(db, applicationId, operator.id, action, comment, fromStatus, toStatus);
  return getApplicationById(applicationId);
}

function cancelApplication(applicationId, operator, { comment } = {}) {
  const db = getDb();
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(applicationId);
  if (!app) {
    throw new AppError(`申请 ${applicationId} 不存在`, 'NOT_FOUND', 404);
  }
  const isOwner = app.applicant_id === operator.id;
  const isAdmin = operator.role === 'admin';
  if (!isOwner && !isAdmin) {
    throw new AppError(
      `无权取消该申请，仅申请人本人或管理员可取消`,
      'PERMISSION_DENIED',
      403,
      { applicant_id: app.applicant_id, operator_id: operator.id, operator_role: operator.role }
    );
  }
  const remark = comment || (isAdmin ? '管理员代取消' : '申请人取消');
  return updateStatus(db, applicationId, operator, STATUS.CANCELLED, 'CANCEL', remark, { cancelRemark: remark });
}

function cloneApplication(applicationId, operator, { applicant_id } = {}) {
  const db = getDb();
  const src = db.prepare('SELECT * FROM applications WHERE id = ?').get(applicationId);
  if (!src) {
    throw new AppError(`申请 ${applicationId} 不存在`, 'NOT_FOUND', 404);
  }

  const isAdmin = operator.role === 'admin';
  const isOwner = src.applicant_id === operator.id;

  if (!isAdmin && !isOwner) {
    throw new AppError(
      `无权复制该申请，仅申请人本人或管理员可复制`,
      'PERMISSION_DENIED',
      403,
      { source_applicant_id: src.applicant_id, operator_id: operator.id, operator_role: operator.role }
    );
  }

  if (!TERMINAL_STATUSES_FOR_CLONE.includes(src.status)) {
    throw new AppError(
      `仅已驳回或已取消的申请可复制，当前状态 ${src.status} 不允许复制`,
      'INVALID_TRANSITION',
      409,
      { current_status: src.status, allowed_statuses: TERMINAL_STATUSES_FOR_CLONE }
    );
  }

  let targetApplicantId = src.applicant_id;
  if (isAdmin && applicant_id !== undefined && applicant_id !== null) {
    const tid = parseInt(applicant_id, 10);
    if (isNaN(tid)) {
      throw new AppError('applicant_id 必须为数字', 'VALIDATION_ERROR', 400);
    }
    const targetUser = db.prepare('SELECT id FROM users WHERE id = ?').get(tid);
    if (!targetUser) {
      throw new AppError(`指定的申请人 ${tid} 不存在`, 'VALIDATION_ERROR', 400);
    }
    targetApplicantId = tid;
  }

  const info = db.prepare(`
    INSERT INTO applications
      (applicant_id, route_name, original_stops, new_stops, effective_start, effective_end, vehicle_id, reason, status, source_application_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    targetApplicantId,
    src.route_name,
    src.original_stops,
    src.new_stops,
    src.effective_start,
    src.effective_end,
    src.vehicle_id,
    src.reason,
    STATUS.PENDING_SUBMITTED,
    src.id
  );

  const newId = info.lastInsertRowid;
  const comment = isAdmin && targetApplicantId !== src.applicant_id
    ? `管理员代复制，源自申请 #${src.id}`
    : `复制自申请 #${src.id}`;
  logApproval(db, newId, operator.id, 'CLONE_RESUBMIT', comment, null, STATUS.PENDING_SUBMITTED);

  return getApplicationById(newId);
}

function dispatchReview(applicationId, operator, { approved, comment } = {}) {
  if (!approved) {
    return updateStatus(getDb(), applicationId, operator, STATUS.REJECTED, 'DISPATCH_REJECT', comment || '调度驳回', { rejectReason: comment || '调度驳回' });
  }
  return updateStatus(getDb(), applicationId, operator, STATUS.DISPATCH_REVIEWED, 'DISPATCH_APPROVE', comment || '调度复核通过');
}

function safetyApprove(applicationId, operator, { approved, comment } = {}) {
  if (!approved) {
    return updateStatus(getDb(), applicationId, operator, STATUS.REJECTED, 'SAFETY_REJECT', comment || '安全驳回', { rejectReason: comment || '安全驳回' });
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

  const timeOverlapRows = db.prepare(`
    SELECT * FROM applications
    WHERE status = 'PUBLISHED'
      AND id != ?
      AND (
        (effective_start <= ? AND effective_end > ?)
        OR (effective_start < ? AND effective_end >= ?)
        OR (effective_start >= ? AND effective_end <= ?)
      )
  `).all(
    app.id,
    app.effective_end, app.effective_start,
    app.effective_end, app.effective_start,
    app.effective_start, app.effective_end
  );

  const currentStops = new Set([
    ...JSON.parse(app.original_stops || '[]'),
    ...JSON.parse(app.new_stops || '[]')
  ]);

  for (const other of timeOverlapRows) {
    if (conflicts.find(c => c.conflicting_application_id === other.id)) continue;
    const otherStops = new Set([
      ...JSON.parse(other.original_stops || '[]'),
      ...JSON.parse(other.new_stops || '[]')
    ]);
    const common = [];
    for (const s of currentStops) {
      if (otherStops.has(s)) common.push(s);
    }
    if (common.length === 0) continue;
    conflicts.push({
      type: 'STOP',
      details: [
        `时间重叠: ${other.effective_start} ~ ${other.effective_end} 与本申请 ${app.effective_start} ~ ${app.effective_end} 重叠`,
        `站点冲突: 共同站点 ${JSON.stringify(common)}`
      ],
      conflicting_application_id: other.id,
      conflicting_route_name: other.route_name
    });
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

  let source_application = null;
  if (app.source_application_id) {
    const src = db.prepare(`
      SELECT a.id, a.route_name, a.status, a.created_at,
             u.id as applicant_id, u.name as applicant_name, u.username as applicant_username, u.role as applicant_role
      FROM applications a
      LEFT JOIN users u ON u.id = a.applicant_id
      WHERE a.id = ?
    `).get(app.source_application_id);
    if (src) {
      source_application = {
        id: src.id,
        route_name: src.route_name,
        status: src.status,
        status_label: STATUS_LABEL[src.status] || src.status,
        created_at: src.created_at,
        applicant: {
          id: src.applicant_id,
          name: src.applicant_name,
          username: src.applicant_username,
          role: src.applicant_role
        }
      };
    }
  }

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
    cancel_remark: app.cancel_remark,
    source_application_id: app.source_application_id || null,
    source_application,
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

function exportApplications({ format = 'json', route_name, start_date, end_date, status, applicant_id, has_cancel_remark, user } = {}) {
  const db = getDb();
  const conditions = [];
  const params = [];
  const filters = {};

  const isPrivileged = user && (user.role === 'admin' || user.role === 'dispatcher' || user.role === 'safety');

  if (status) {
    conditions.push('status = ?');
    params.push(status);
    filters.status = status;
  }
  if (route_name) {
    conditions.push('route_name LIKE ?');
    params.push(`%${route_name}%`);
    filters.route_name = route_name;
  }
  if (start_date) {
    conditions.push('effective_end >= ?');
    params.push(new Date(start_date).toISOString());
    filters.start_date = start_date;
  }
  if (end_date) {
    conditions.push('effective_start <= ?');
    params.push(new Date(end_date).toISOString());
    filters.end_date = end_date;
  }

  if (has_cancel_remark !== undefined && has_cancel_remark !== null && has_cancel_remark !== '') {
    const val = String(has_cancel_remark).toLowerCase();
    if (val === 'true' || val === '1' || val === 'yes') {
      conditions.push('cancel_remark IS NOT NULL AND cancel_remark != ?');
      params.push('');
      filters.has_cancel_remark = true;
    } else if (val === 'false' || val === '0' || val === 'no') {
      conditions.push('(cancel_remark IS NULL OR cancel_remark = ?)');
      params.push('');
      filters.has_cancel_remark = false;
    }
  }

  if (applicant_id !== undefined && applicant_id !== null && applicant_id !== '') {
    const targetId = parseInt(applicant_id, 10);
    if (isNaN(targetId)) {
      throw new AppError('applicant_id 必须为数字', 'VALIDATION_ERROR', 400);
    }
    if (!isPrivileged && user && targetId !== user.id) {
      throw new AppError(
        '无权导出其他申请人的申请，仅调度、安全员或管理员可按申请人筛选',
        'PERMISSION_DENIED',
        403,
        { operator_id: user ? user.id : null, operator_role: user ? user.role : null, requested_applicant_id: targetId }
      );
    }
    conditions.push('applicant_id = ?');
    params.push(targetId);
    filters.applicant_id = targetId;
  } else if (!isPrivileged && user) {
    conditions.push('applicant_id = ?');
    params.push(user.id);
    filters.applicant_id = user.id;
    filters.scope_note = '普通老师默认仅导出本人申请';
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const rows = db.prepare(`SELECT * FROM applications ${where} ORDER BY id ASC`).all(...params);
  const items = rows.map(r => serializeApplication(r, db));

  if (format === 'csv') {
    return { csv: toCSV(items), count: items.length, filters };
  }
  return { count: items.length, items, filters, filter_summary: buildFilterSummary(filters, user) };
}

function buildFilterSummary(filters, user) {
  const parts = [];
  if (filters.status) parts.push(`状态=${filters.status}`);
  if (filters.route_name) parts.push(`线路含"${filters.route_name}"`);
  if (filters.start_date) parts.push(`生效结束>=${filters.start_date}`);
  if (filters.end_date) parts.push(`生效开始<=${filters.end_date}`);
  if (filters.has_cancel_remark === true) parts.push('有取消备注');
  if (filters.has_cancel_remark === false) parts.push('无取消备注');
  if (filters.applicant_id !== undefined) parts.push(`申请人ID=${filters.applicant_id}`);
  if (user) parts.push(`操作人=${user.name}(id=${user.id},role=${user.role})`);
  return parts.join('; ') || '无筛选条件';
}

function toCSV(items) {
  const headers = [
    'ID', '线路', '原站点', '新站点', '移除站点', '新增站点',
    '生效开始', '生效结束', '车辆', '原因', '状态', '状态描述',
    '驳回原因', '取消备注', '申请人', '来源申请ID', '来源申请人',
    '创建时间', '更新时间'
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
      it.cancel_remark || '',
      it.applicant ? it.applicant.name : '',
      it.source_application_id || '',
      it.source_application && it.source_application.applicant ? it.source_application.applicant.name : '',
      it.created_at, it.updated_at
    ].map(escape).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

const DEFAULT_TIMEOUT_MINUTES = 60;

function getTimeoutMinutes() {
  const raw = process.env.APPROVAL_TIMEOUT_MINUTES;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_TIMEOUT_MINUTES;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n <= 0) return DEFAULT_TIMEOUT_MINUTES;
  return n;
}

const NEXT_ROLE_FOR_STATUS = {
  PENDING_SUBMITTED: 'dispatcher',
  DISPATCH_REVIEWED: 'safety',
  SAFETY_APPROVED: 'admin'
};

const NEXT_ROLE_LABEL = {
  dispatcher: '调度复核',
  safety: '安全审批',
  admin: '发布'
};

const NON_TERMINAL_STATUSES = ['PENDING_SUBMITTED', 'DISPATCH_REVIEWED', 'SAFETY_APPROVED'];
const TERMINAL_STATUSES_FOR_CLONE = ['REJECTED', 'CANCELLED'];

function getReminders(user, { timeout_status, route_name, status } = {}) {
  const db = getDb();
  const timeoutMinutes = getTimeoutMinutes();
  const isPrivileged = user.role === 'admin' || user.role === 'dispatcher' || user.role === 'safety';

  const conditions = [];
  const params = [];
  const appliedFilters = { timeout_minutes: timeoutMinutes };

  if (isPrivileged) {
    if (user.role === 'dispatcher') {
      conditions.push('status = ?');
      params.push('PENDING_SUBMITTED');
      appliedFilters.role_scope = 'dispatcher: 待调度复核';
    } else if (user.role === 'safety') {
      conditions.push('status = ?');
      params.push('DISPATCH_REVIEWED');
      appliedFilters.role_scope = 'safety: 待安全审批';
    } else if (user.role === 'admin') {
      conditions.push('status = ?');
      params.push('SAFETY_APPROVED');
      appliedFilters.role_scope = 'admin: 待发布';
    }
  } else {
    conditions.push('applicant_id = ?');
    params.push(user.id);
    conditions.push('status IN (?, ?, ?)');
    params.push('PENDING_SUBMITTED', 'DISPATCH_REVIEWED', 'SAFETY_APPROVED');
    appliedFilters.role_scope = 'teacher: 本人未结束的申请';
  }

  if (status) {
    conditions.push('status = ?');
    params.push(status);
    appliedFilters.status = status;
  }

  if (route_name) {
    conditions.push('route_name LIKE ?');
    params.push(`%${route_name}%`);
    appliedFilters.route_name = route_name;
  }

  const where = 'WHERE ' + conditions.join(' AND ');
  const rows = db.prepare(`SELECT * FROM applications ${where} ORDER BY updated_at ASC`).all(...params);

  const now = Date.now();
  const items = [];
  for (const r of rows) {
    const updatedAt = new Date(r.updated_at).getTime();
    const elapsedMs = now - updatedAt;
    const elapsedMinutes = elapsedMs / 60000;
    const minutesToTimeout = timeoutMinutes - elapsedMinutes;
    const isOverdue = minutesToTimeout <= 0;
    const isWarning = !isOverdue && minutesToTimeout <= timeoutMinutes;

    if (timeout_status === 'overdue' && !isOverdue) continue;
    if (timeout_status === 'pending' && isOverdue) continue;

    const nextRole = NEXT_ROLE_FOR_STATUS[r.status] || null;
    items.push({
      id: r.id,
      route_name: r.route_name,
      effective_start: r.effective_start,
      effective_end: r.effective_end,
      vehicle_id: r.vehicle_id,
      reason: r.reason,
      status: r.status,
      status_label: STATUS_LABEL[r.status] || r.status,
      applicant_id: r.applicant_id,
      next_role: nextRole,
      next_role_label: nextRole ? NEXT_ROLE_LABEL[nextRole] : null,
      last_updated_at: r.updated_at,
      minutes_to_timeout: Math.round(minutesToTimeout * 100) / 100,
      is_overdue: isOverdue,
      is_warning: isWarning
    });
  }

  if (timeout_status) appliedFilters.timeout_status = timeout_status;

  const overdueCount = items.filter(i => i.is_overdue).length;
  const warningCount = items.filter(i => !i.is_overdue && i.is_warning).length;

  return {
    timeout_minutes: timeoutMinutes,
    total: items.length,
    overdue_count: overdueCount,
    warning_count: warningCount,
    filters: appliedFilters,
    items
  };
}

module.exports = {
  STATUS, STATUS_LABEL, VALID_TRANSITIONS,
  DEFAULT_TIMEOUT_MINUTES,
  getTimeoutMinutes,
  createApplication,
  cloneApplication,
  cancelApplication,
  dispatchReview,
  safetyApprove,
  publish,
  getApplicationById,
  listApplications,
  exportApplications,
  getReminders,
  detectConflicts,
  parseDate
};
