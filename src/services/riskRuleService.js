const { getDb } = require('../db');
const { AppError } = require('../utils/response');

const RULE_TYPES = ['BANNED_STOP', 'BANNED_TIME_WINDOW', 'VEHICLE_RESTRICTION', 'KEYWORD'];
const RULE_TYPE_LABEL = {
  BANNED_STOP: '禁用站点',
  BANNED_TIME_WINDOW: '禁行时间段',
  VEHICLE_RESTRICTION: '车辆限制',
  KEYWORD: '线路关键词'
};
const RULE_STATUSES = ['ACTIVE', 'INACTIVE'];
const RULE_STATUS_LABEL = {
  ACTIVE: '启用',
  INACTIVE: '停用'
};

function validateRuleConfig(ruleType, ruleConfig) {
  const errors = [];
  if (!ruleConfig || typeof ruleConfig !== 'object') {
    errors.push('rule_config 必须是对象');
    return errors;
  }
  switch (ruleType) {
    case 'BANNED_STOP': {
      if (!Array.isArray(ruleConfig.stops) || ruleConfig.stops.length === 0) {
        errors.push('BANNED_STOP 规则需提供非空 stops 数组');
      } else {
        for (const s of ruleConfig.stops) {
          if (typeof s !== 'string' || !s.trim()) {
            errors.push('stops 中每个元素必须是非空字符串');
            break;
          }
        }
      }
      break;
    }
    case 'BANNED_TIME_WINDOW': {
      const { start_hour, start_minute, end_hour, end_minute } = ruleConfig;
      for (const [k, v] of [['start_hour', start_hour], ['start_minute', start_minute], ['end_hour', end_hour], ['end_minute', end_minute]]) {
        if (v === undefined || v === null || typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
          errors.push(`${k} 必须是非负整数`);
        }
      }
      if (start_hour > 23 || end_hour > 23) errors.push('小时必须在 0-23 之间');
      if (start_minute > 59 || end_minute > 59) errors.push('分钟必须在 0-59 之间');
      break;
    }
    case 'VEHICLE_RESTRICTION': {
      if (!Array.isArray(ruleConfig.vehicles) || ruleConfig.vehicles.length === 0) {
        errors.push('VEHICLE_RESTRICTION 规则需提供非空 vehicles 数组');
      } else {
        for (const v of ruleConfig.vehicles) {
          if (typeof v !== 'string' || !v.trim()) {
            errors.push('vehicles 中每个元素必须是非空字符串');
            break;
          }
        }
      }
      if (!['ALLOW', 'DENY'].includes(ruleConfig.mode)) {
        errors.push('mode 必须是 ALLOW 或 DENY');
      }
      break;
    }
    case 'KEYWORD': {
      if (!Array.isArray(ruleConfig.keywords) || ruleConfig.keywords.length === 0) {
        errors.push('KEYWORD 规则需提供非空 keywords 数组');
      } else {
        for (const k of ruleConfig.keywords) {
          if (typeof k !== 'string' || !k.trim()) {
            errors.push('keywords 中每个元素必须是非空字符串');
            break;
          }
        }
      }
      if (!['reason', 'route_name', 'all'].includes(ruleConfig.field)) {
        errors.push('field 必须是 reason / route_name / all');
      }
      break;
    }
    default:
      errors.push(`未知规则类型: ${ruleType}`);
  }
  return errors;
}

function parseRuleConfig(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}

function serializeRule(rule, db) {
  if (!rule) return null;
  const creator = db.prepare('SELECT id, username, name, role FROM users WHERE id = ?').get(rule.created_by);
  return {
    id: rule.id,
    rule_type: rule.rule_type,
    rule_type_label: RULE_TYPE_LABEL[rule.rule_type] || rule.rule_type,
    name: rule.name,
    description: rule.description || null,
    rule_config: parseRuleConfig(rule.rule_config),
    status: rule.status,
    status_label: RULE_STATUS_LABEL[rule.status] || rule.status,
    hit_count: rule.hit_count || 0,
    last_hit_at: rule.last_hit_at || null,
    created_by: creator ? { id: creator.id, name: creator.name, username: creator.username, role: creator.role } : null,
    created_at: rule.created_at,
    updated_at: rule.updated_at
  };
}

function createRule(user, body) {
  const { rule_type, name, description, rule_config } = body || {};
  if (!RULE_TYPES.includes(rule_type)) {
    throw new AppError(`rule_type 必须为 ${RULE_TYPES.join('/')}`, 'VALIDATION_ERROR', 400, { allowed: RULE_TYPES });
  }
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new AppError('name 必填且为非空字符串', 'VALIDATION_ERROR', 400);
  }
  const cfgErrors = validateRuleConfig(rule_type, rule_config);
  if (cfgErrors.length > 0) {
    throw new AppError('rule_config 校验失败', 'VALIDATION_ERROR', 400, cfgErrors);
  }
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO risk_rules (rule_type, name, description, rule_config, status, created_by)
    VALUES (?, ?, ?, ?, 'ACTIVE', ?)
  `).run(
    rule_type,
    name.trim(),
    description ? description.trim() : null,
    JSON.stringify(rule_config),
    user.id
  );
  return getRuleById(info.lastInsertRowid);
}

function updateRule(ruleId, user, body) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM risk_rules WHERE id = ?').get(ruleId);
  if (!existing) {
    throw new AppError(`规则 ${ruleId} 不存在`, 'NOT_FOUND', 404);
  }
  const { rule_type, name, description, rule_config, status } = body || {};
  const updates = [];
  const params = [];

  let finalRuleType = existing.rule_type;
  if (rule_type !== undefined) {
    if (!RULE_TYPES.includes(rule_type)) {
      throw new AppError(`rule_type 必须为 ${RULE_TYPES.join('/')}`, 'VALIDATION_ERROR', 400);
    }
    finalRuleType = rule_type;
    updates.push('rule_type = ?');
    params.push(rule_type);
  }
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new AppError('name 必须为非空字符串', 'VALIDATION_ERROR', 400);
    }
    updates.push('name = ?');
    params.push(name.trim());
  }
  if (description !== undefined) {
    updates.push('description = ?');
    params.push(description ? description.trim() : null);
  }
  if (rule_config !== undefined) {
    const cfgErrors = validateRuleConfig(finalRuleType, rule_config);
    if (cfgErrors.length > 0) {
      throw new AppError('rule_config 校验失败', 'VALIDATION_ERROR', 400, cfgErrors);
    }
    updates.push('rule_config = ?');
    params.push(JSON.stringify(rule_config));
  }
  if (status !== undefined) {
    if (!RULE_STATUSES.includes(status)) {
      throw new AppError(`status 必须为 ${RULE_STATUSES.join('/')}`, 'VALIDATION_ERROR', 400);
    }
    updates.push('status = ?');
    params.push(status);
  }

  if (updates.length === 0) {
    return serializeRule(existing, db);
  }
  updates.push("updated_at = datetime('now','localtime')");
  params.push(ruleId);

  db.prepare(`UPDATE risk_rules SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  return getRuleById(ruleId);
}

function toggleRuleStatus(ruleId, user, targetStatus) {
  if (!RULE_STATUSES.includes(targetStatus)) {
    throw new AppError(`status 必须为 ${RULE_STATUSES.join('/')}`, 'VALIDATION_ERROR', 400);
  }
  return updateRule(ruleId, user, { status: targetStatus });
}

function deleteRule(ruleId, user) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM risk_rules WHERE id = ?').get(ruleId);
  if (!existing) {
    throw new AppError(`规则 ${ruleId} 不存在`, 'NOT_FOUND', 404);
  }
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM risk_rule_hits WHERE rule_id = ?').run(ruleId);
    db.prepare('DELETE FROM risk_rules WHERE id = ?').run(ruleId);
  });
  tx();
  return { id: ruleId, deleted: true };
}

function getRuleById(ruleId) {
  const db = getDb();
  const rule = db.prepare('SELECT * FROM risk_rules WHERE id = ?').get(ruleId);
  return serializeRule(rule, db);
}

function listRules({ rule_type, status, page = 1, page_size = 20 } = {}) {
  const db = getDb();
  const conditions = [];
  const params = [];
  if (rule_type) {
    conditions.push('rule_type = ?');
    params.push(rule_type);
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM risk_rules ${where}`).get(...params).cnt;
  const offset = (Math.max(1, page) - 1) * Math.max(1, page_size);
  const rows = db.prepare(`
    SELECT * FROM risk_rules ${where}
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(...params, Math.max(1, page_size), offset);
  return {
    total,
    page: Math.max(1, page),
    page_size: Math.max(1, page_size),
    items: rows.map(r => serializeRule(r, db))
  };
}

function getRuleHits(ruleId, { page = 1, page_size = 20 } = {}) {
  const db = getDb();
  const rule = db.prepare('SELECT id FROM risk_rules WHERE id = ?').get(ruleId);
  if (!rule) throw new AppError(`规则 ${ruleId} 不存在`, 'NOT_FOUND', 404);
  const total = db.prepare('SELECT COUNT(*) as cnt FROM risk_rule_hits WHERE rule_id = ?').get(ruleId).cnt;
  const offset = (Math.max(1, page) - 1) * Math.max(1, page_size);
  const rows = db.prepare(`
    SELECT rh.*, a.route_name as application_route_name, u.name as operator_name
    FROM risk_rule_hits rh
    LEFT JOIN applications a ON a.id = rh.application_id
    LEFT JOIN users u ON u.id = rh.created_by
    WHERE rh.rule_id = ?
    ORDER BY rh.id DESC
    LIMIT ? OFFSET ?
  `).all(ruleId, Math.max(1, page_size), offset);
  return {
    total,
    page: Math.max(1, page),
    page_size: Math.max(1, page_size),
    items: rows.map(r => ({
      id: r.id,
      rule_id: r.rule_id,
      application_id: r.application_id,
      application_route_name: r.application_route_name || null,
      hit_detail: parseRuleConfig(r.hit_detail),
      created_by: r.created_by ? { id: r.created_by, name: r.operator_name || null } : null,
      created_at: r.created_at
    }))
  };
}

function listRuleHitsForUser(user, { page = 1, page_size = 20 } = {}) {
  const db = getDb();
  const conditions = [];
  const params = [];
  if (user.role === 'teacher') {
    conditions.push(`rh.application_id IN (SELECT id FROM applications WHERE applicant_id = ?)`);
    params.push(user.id);
  }
  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM risk_rule_hits rh ${where}`).get(...params).cnt;
  const offset = (Math.max(1, page) - 1) * Math.max(1, page_size);
  const rows = db.prepare(`
    SELECT rh.*, rr.name as rule_name, rr.rule_type as rule_type,
           a.route_name as application_route_name, u.name as operator_name
    FROM risk_rule_hits rh
    LEFT JOIN risk_rules rr ON rr.id = rh.rule_id
    LEFT JOIN applications a ON a.id = rh.application_id
    LEFT JOIN users u ON u.id = rh.created_by
    ${where}
    ORDER BY rh.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, Math.max(1, page_size), offset);
  return {
    total,
    page: Math.max(1, page),
    page_size: Math.max(1, page_size),
    items: rows.map(r => ({
      id: r.id,
      rule_id: r.rule_id,
      rule_name: r.rule_name,
      rule_type: r.rule_type,
      rule_type_label: RULE_TYPE_LABEL[r.rule_type] || r.rule_type,
      application_id: r.application_id,
      application_route_name: r.application_route_name || null,
      hit_detail: parseRuleConfig(r.hit_detail),
      created_by: r.created_by ? { id: r.created_by, name: r.operator_name || null } : null,
      created_at: r.created_at
    }))
  };
}

function _inTimeWindow(startH, startM, endH, endM, targetH, targetM) {
  const toMin = (h, m) => h * 60 + m;
  const s = toMin(startH, startM);
  const e = toMin(endH, endM);
  const t = toMin(targetH, targetM);
  if (s <= e) return t >= s && t < e;
  return t >= s || t < e;
}

function checkApplicationAgainstRules(db, application, operator, { stage = 'SUBMIT' } = {}) {
  const activeRules = db.prepare(`SELECT * FROM risk_rules WHERE status = 'ACTIVE'`).all();
  const hits = [];
  for (const rule of activeRules) {
    const cfg = parseRuleConfig(rule.rule_config);
    if (!cfg) continue;
    const detail = { rule_id: rule.id, rule_name: rule.name, rule_type: rule.rule_type, stage };
    let matched = false;
    switch (rule.rule_type) {
      case 'BANNED_STOP': {
        const stops = new Set([
          ...(JSON.parse(application.original_stops || '[]')),
          ...(JSON.parse(application.new_stops || '[]'))
        ]);
        const hitStops = cfg.stops.filter(s => stops.has(s));
        if (hitStops.length > 0) {
          matched = true;
          detail.hit_stops = hitStops;
          detail.message = `禁用站点命中: ${hitStops.join('、')}`;
        }
        break;
      }
      case 'BANNED_TIME_WINDOW': {
        const checkTimes = [application.effective_start, application.effective_end];
        const hitTimes = [];
        for (const iso of checkTimes) {
          if (!iso) continue;
          const d = new Date(iso);
          if (isNaN(d.getTime())) continue;
          const h = d.getUTCHours();
          const m = d.getUTCMinutes();
          if (_inTimeWindow(cfg.start_hour, cfg.start_minute, cfg.end_hour, cfg.end_minute, h, m)) {
            hitTimes.push({ time: iso, local_hour: h, local_minute: m });
          }
        }
        if (hitTimes.length > 0) {
          matched = true;
          detail.window = `${String(cfg.start_hour).padStart(2, '0')}:${String(cfg.start_minute).padStart(2, '0')}-${String(cfg.end_hour).padStart(2, '0')}:${String(cfg.end_minute).padStart(2, '0')} UTC`;
          detail.hit_times = hitTimes;
          detail.message = `禁行时间段命中: 窗口 ${detail.window}`;
        }
        break;
      }
      case 'VEHICLE_RESTRICTION': {
        const vid = application.vehicle_id;
        if (vid) {
          const inList = cfg.vehicles.includes(vid);
          if ((cfg.mode === 'DENY' && inList) || (cfg.mode === 'ALLOW' && !inList)) {
            matched = true;
            detail.vehicle_id = vid;
            detail.mode = cfg.mode;
            detail.vehicles = cfg.vehicles;
            detail.message = cfg.mode === 'DENY'
              ? `车辆限制命中: ${vid} 在禁用列表中`
              : `车辆限制命中: ${vid} 不在允许列表中`;
          }
        }
        break;
      }
      case 'KEYWORD': {
        const sources = [];
        if (cfg.field === 'reason' || cfg.field === 'all') sources.push(application.reason || '');
        if (cfg.field === 'route_name' || cfg.field === 'all') sources.push(application.route_name || '');
        const combined = sources.join(' ');
        const hitKeywords = cfg.keywords.filter(k => combined.includes(k));
        if (hitKeywords.length > 0) {
          matched = true;
          detail.hit_keywords = hitKeywords;
          detail.field = cfg.field;
          detail.message = `关键词命中: ${hitKeywords.join('、')}`;
        }
        break;
      }
    }
    if (matched) {
      hits.push(detail);
    }
  }
  if (hits.length === 0) return { violated: false, hits: [] };
  for (const h of hits) {
    db.prepare(`
      INSERT INTO risk_rule_hits (rule_id, application_id, hit_detail, created_by)
      VALUES (?, ?, ?, ?)
    `).run(h.rule_id, application.id || null, JSON.stringify(h), operator ? operator.id : null);
    db.prepare(`
      UPDATE risk_rules SET hit_count = hit_count + 1, last_hit_at = datetime('now','localtime'), updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(h.rule_id);
  }
  return { violated: true, hits };
}

function validateApplication(applicationRow, operator, { stage = 'SUBMIT' } = {}) {
  const db = getDb();
  const result = checkApplicationAgainstRules(db, applicationRow, operator, { stage });
  return result;
}

function rulesToCSV(rules) {
  const headers = ['ID', '规则名称', '规则类型', '规则类型描述', '状态', '状态描述', '命中次数', '最近命中时间', '创建人', '配置JSON', '描述', '创建时间', '更新时间'];
  const escape = (val) => {
    if (val === null || val === undefined) return '';
    const s = typeof val === 'string' ? val : JSON.stringify(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const lines = [headers.join(',')];
  for (const r of rules) {
    lines.push([
      r.id,
      r.name,
      r.rule_type,
      r.rule_type_label,
      r.status,
      r.status_label,
      r.hit_count,
      r.last_hit_at || '',
      r.created_by ? r.created_by.name : '',
      escape(r.rule_config),
      r.description || '',
      r.created_at,
      r.updated_at
    ].map(escape).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

function exportRules({ format = 'json', rule_type, status } = {}) {
  const db = getDb();
  const conditions = [];
  const params = [];
  if (rule_type) { conditions.push('rule_type = ?'); params.push(rule_type); }
  if (status) { conditions.push('status = ?'); params.push(status); }
  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const rows = db.prepare(`SELECT * FROM risk_rules ${where} ORDER BY id ASC`).all(...params);
  const items = rows.map(r => serializeRule(r, db));
  const filters = { rule_type: rule_type || null, status: status || null };
  if (format === 'csv') {
    return { csv: rulesToCSV(items), count: items.length, filters };
  }
  return { count: items.length, items, filters };
}

function importRules(user, format, rawData) {
  const db = getDb();
  let items = [];
  if (format === 'json') {
    if (Array.isArray(rawData)) items = rawData;
    else if (rawData && Array.isArray(rawData.items)) items = rawData.items;
    else throw new AppError('JSON 导入数据格式错误，需为数组或含 items 字段的对象', 'VALIDATION_ERROR', 400);
  } else if (format === 'csv') {
    items = parseCSVRules(rawData);
  } else {
    throw new AppError('不支持的导入格式', 'VALIDATION_ERROR', 400);
  }
  const results = { success: 0, failed: 0, errors: [], created_ids: [] };
  const tx = db.transaction(() => {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      try {
        const rule_type = it.rule_type;
        const name = it.name;
        const description = it.description;
        let rule_config = it.rule_config;
        if (typeof rule_config === 'string') {
          try { rule_config = JSON.parse(rule_config); } catch { rule_config = null; }
        }
        if (!RULE_TYPES.includes(rule_type)) {
          throw new Error(`第 ${i + 1} 条: rule_type 非法`);
        }
        if (!name || typeof name !== 'string' || !name.trim()) {
          throw new Error(`第 ${i + 1} 条: name 不能为空`);
        }
        const cfgErrors = validateRuleConfig(rule_type, rule_config);
        if (cfgErrors.length > 0) {
          throw new Error(`第 ${i + 1} 条: ${cfgErrors.join('; ')}`);
        }
        const status = RULE_STATUSES.includes(it.status) ? it.status : 'ACTIVE';
        const info = db.prepare(`
          INSERT INTO risk_rules (rule_type, name, description, rule_config, status, created_by)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(rule_type, name.trim(), description ? String(description).trim() : null, JSON.stringify(rule_config), status, user.id);
        results.created_ids.push(info.lastInsertRowid);
        results.success++;
      } catch (e) {
        results.failed++;
        results.errors.push(e.message);
      }
    }
  });
  tx();
  return results;
}

function parseCSVRules(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headerLine = lines[0];
  const headers = splitCSVLine(headerLine);
  const idx = {
    rule_type: headers.indexOf('规则类型'),
    name: headers.indexOf('规则名称'),
    description: headers.indexOf('描述'),
    rule_config: headers.indexOf('配置JSON'),
    status: headers.indexOf('状态')
  };
  const items = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i]);
    const it = {};
    if (idx.rule_type >= 0) it.rule_type = cols[idx.rule_type];
    if (idx.name >= 0) it.name = cols[idx.name];
    if (idx.description >= 0) it.description = cols[idx.description];
    if (idx.rule_config >= 0) it.rule_config = cols[idx.rule_config];
    if (idx.status >= 0) it.status = cols[idx.status];
    items.push(it);
  }
  return items;
}

function splitCSVLine(line) {
  const result = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuote = false; }
      } else { cur += ch; }
    } else {
      if (ch === '"') { inQuote = true; }
      else if (ch === ',') { result.push(cur); cur = ''; }
      else { cur += ch; }
    }
  }
  result.push(cur);
  return result;
}

module.exports = {
  RULE_TYPES, RULE_TYPE_LABEL, RULE_STATUSES, RULE_STATUS_LABEL,
  createRule, updateRule, toggleRuleStatus, deleteRule,
  getRuleById, listRules, getRuleHits, listRuleHitsForUser,
  validateApplication, exportRules, importRules,
  validateRuleConfig
};
