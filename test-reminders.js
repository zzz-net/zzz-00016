const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const BASE = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, 'data', 'school-bus.db');

let pass = 0;
let fail = 0;
const results = [];

function request(method, urlPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + urlPath);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + (url.search || ''),
      headers: { 'Content-Type': 'application/json', ...headers }
    };
    if (body) {
      const b = JSON.stringify(body);
      opts.headers['Content-Length'] = Buffer.byteLength(b);
    }
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null, raw: data });
        } catch {
          resolve({ status: res.statusCode, body: null, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function assert(label, cond, detail = '') {
  if (cond) {
    pass++;
    results.push({ label, ok: true, detail });
  } else {
    fail++;
    results.push({ label, ok: false, detail });
  }
  console.log((cond ? '  PASS' : '  FAIL') + ': ' + label + (detail ? ' — ' + detail : ''));
}

function section(title) {
  console.log('\n=== ' + title + ' ===');
}

function deleteDbIfExists() {
  if (fs.existsSync(DB_PATH)) {
    try { fs.unlinkSync(DB_PATH); } catch (e) {}
  }
  const shm = DB_PATH + '-shm';
  const wal = DB_PATH + '-wal';
  if (fs.existsSync(shm)) { try { fs.unlinkSync(shm); } catch (e) {} }
  if (fs.existsSync(wal)) { try { fs.unlinkSync(wal); } catch (e) {} }
}

let serverProc = null;

function startServer(timeoutMinutes) {
  return new Promise((resolve) => {
    const env = { ...process.env, PORT: '3000' };
    if (timeoutMinutes !== undefined && timeoutMinutes !== null) {
      env.APPROVAL_TIMEOUT_MINUTES = String(timeoutMinutes);
    }
    serverProc = spawn('node', ['src/server.js'], {
      cwd: __dirname,
      stdio: 'ignore',
      env
    });
    setTimeout(resolve, 1500);
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (serverProc && !serverProc.killed) {
      serverProc.kill('SIGTERM');
      serverProc.on('close', () => setTimeout(resolve, 300));
    } else {
      resolve();
    }
  });
}

async function waitForHealth() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await request('GET', '/health');
      if (r.status === 200) return;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('Server not ready');
}

async function createApplication(userId, suffix) {
  const r = await request('POST', '/api/applications', {
    route_name: '提醒测试线' + suffix,
    original_stops: ['A', 'B', 'C'],
    new_stops: ['A', 'D', 'C'],
    effective_start: '2026-09-01T07:00:00.000Z',
    effective_end: '2026-09-01T09:00:00.000Z',
    vehicle_id: 'BUS-REM' + suffix,
    reason: '提醒测试原因' + suffix
  }, { 'X-User-Id': String(userId) });
  return r.body.data.id;
}

async function advanceTo(appId, targetStatus) {
  if (targetStatus === 'DISPATCH_REVIEWED') {
    await request('POST', '/api/applications/' + appId + '/dispatch-review', { approved: true }, { 'X-User-Id': '3' });
  } else if (targetStatus === 'SAFETY_APPROVED') {
    await request('POST', '/api/applications/' + appId + '/dispatch-review', { approved: true }, { 'X-User-Id': '3' });
    await request('POST', '/api/applications/' + appId + '/safety-approve', { approved: true }, { 'X-User-Id': '4' });
  } else if (targetStatus === 'PUBLISHED') {
    await request('POST', '/api/applications/' + appId + '/dispatch-review', { approved: true }, { 'X-User-Id': '3' });
    await request('POST', '/api/applications/' + appId + '/safety-approve', { approved: true }, { 'X-User-Id': '4' });
    await request('POST', '/api/applications/' + appId + '/publish', null, { 'X-User-Id': '5' });
  } else if (targetStatus === 'REJECTED') {
    await request('POST', '/api/applications/' + appId + '/dispatch-review', { approved: false, comment: '驳回测试' }, { 'X-User-Id': '3' });
  }
}

function setApplicationUpdatedAt(appId, minutesAgo) {
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH);
  const t = new Date(Date.now() - minutesAgo * 60000).toISOString().replace('T', ' ').replace('Z', '');
  db.prepare('UPDATE applications SET updated_at = ? WHERE id = ?').run(t, appId);
  db.close();
}

function countAuditLogsByAction(action) {
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH);
  const row = db.prepare('SELECT COUNT(*) as cnt FROM audit_logs WHERE action = ?').get(action);
  db.close();
  return row ? row.cnt : 0;
}

function getLatestAuditLog(action) {
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH);
  const row = db.prepare('SELECT * FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT 1').get(action);
  db.close();
  if (row && row.detail) {
    try { row.detail = JSON.parse(row.detail); } catch (_) {}
  }
  return row;
}

(async () => {
  console.log('\n======== 校车改线 —— 待处理提醒全场景回归测试 ========\n');

  section('准备：清空数据库并启动服务（默认超时阈值 60 分钟）');

  deleteDbIfExists();
  spawnSync('node', ['src/scripts/init-db.js'], { cwd: __dirname, stdio: 'inherit' });
  await startServer();
  await waitForHealth();
  console.log('  服务就绪（默认超时阈值 60 分钟）');

  // =====================================================
  section('场景 1：角色权限 —— 调度员只能看到 PENDING_SUBMITTED');

  const app1_pending = await createApplication(1, '-A');
  const app2_pending = await createApplication(2, '-B');
  await advanceTo(app2_pending, 'DISPATCH_REVIEWED');

  const rDispatch = await request('GET', '/api/applications/reminders', null, { 'X-User-Id': '3' });
  assert('调度员查询返回 200', rDispatch.status === 200, 'status=' + rDispatch.status);
  assert('调度员返回 success=true', rDispatch.body && rDispatch.body.success === true);
  assert('调度员 timeout_minutes = 60（默认）', rDispatch.body && rDispatch.body.data && rDispatch.body.data.timeout_minutes === 60);
  assert('调度员 items 含 1 条（仅 PENDING_SUBMITTED）',
    rDispatch.body && rDispatch.body.data && rDispatch.body.data.items.length === 1,
    '实际=' + (rDispatch.body && rDispatch.body.data ? rDispatch.body.data.items.length : 'N/A'));
  if (rDispatch.body && rDispatch.body.data && rDispatch.body.data.items.length > 0) {
    const item = rDispatch.body.data.items[0];
    assert('调度员命中项 status = PENDING_SUBMITTED', item.status === 'PENDING_SUBMITTED');
    assert('调度员命中项 status_label = 待调度复核', item.status_label === '待调度复核');
    assert('调度员命中项 next_role = dispatcher', item.next_role === 'dispatcher');
    assert('调度员命中项 next_role_label = 调度复核', item.next_role_label === '调度复核');
    assert('调度员命中项含 minutes_to_timeout 数字', typeof item.minutes_to_timeout === 'number');
    assert('调度员命中项含 is_overdue 布尔', typeof item.is_overdue === 'boolean');
    assert('调度员命中项含 is_warning 布尔', typeof item.is_warning === 'boolean');
    assert('调度员命中项含 last_updated_at', !!item.last_updated_at);
    assert('调度员命中项含 applicant_id', item.applicant_id === 1);
    assert('调度员命中项含 route_name、effective_start/end、vehicle_id、reason',
      !!item.route_name && !!item.effective_start && !!item.effective_end && 'vehicle_id' in item && !!item.reason);
  }
  assert('调度员返回 total = items.length',
    rDispatch.body && rDispatch.body.data && rDispatch.body.data.total === rDispatch.body.data.items.length);
  assert('调度员 filters.role_scope 正确',
    rDispatch.body && rDispatch.body.data && rDispatch.body.data.filters && rDispatch.body.data.filters.role_scope === 'dispatcher: 待调度复核');

  // =====================================================
  section('场景 2：角色权限 —— 安全员只能看到 DISPATCH_REVIEWED');

  const rSafety = await request('GET', '/api/applications/reminders', null, { 'X-User-Id': '4' });
  assert('安全员查询返回 200', rSafety.status === 200);
  assert('安全员 items 含 1 条（仅 DISPATCH_REVIEWED）',
    rSafety.body && rSafety.body.data && rSafety.body.data.items.length === 1,
    '实际=' + (rSafety.body && rSafety.body.data ? rSafety.body.data.items.length : 'N/A'));
  if (rSafety.body && rSafety.body.data && rSafety.body.data.items.length > 0) {
    const item = rSafety.body.data.items[0];
    assert('安全员命中项 status = DISPATCH_REVIEWED', item.status === 'DISPATCH_REVIEWED');
    assert('安全员命中项 next_role = safety', item.next_role === 'safety');
    assert('安全员命中项 next_role_label = 安全审批', item.next_role_label === '安全审批');
  }
  assert('安全员 filters.role_scope 正确',
    rSafety.body && rSafety.body.data && rSafety.body.data.filters && rSafety.body.data.filters.role_scope === 'safety: 待安全审批');

  // =====================================================
  section('场景 3：角色权限 —— admin 能看到全部三种待处理状态');

  const app3_safety = await createApplication(1, '-C');
  await advanceTo(app3_safety, 'SAFETY_APPROVED');

  const rAdmin = await request('GET', '/api/applications/reminders', null, { 'X-User-Id': '5' });
  assert('admin 查询返回 200', rAdmin.status === 200);
  assert('admin items 含 3 条（三种待处理状态各一条）',
    rAdmin.body && rAdmin.body.data && rAdmin.body.data.items.length === 3,
    '实际=' + (rAdmin.body && rAdmin.body.data ? rAdmin.body.data.items.length : 'N/A'));
  if (rAdmin.body && rAdmin.body.data) {
    const statuses = rAdmin.body.data.items.map(i => i.status).sort();
    assert('admin 命中三种状态',
      statuses.join(',') === 'DISPATCH_REVIEWED,PENDING_SUBMITTED,SAFETY_APPROVED',
      '实际=' + statuses.join(','));
    const safetyApproved = rAdmin.body.data.items.find(i => i.status === 'SAFETY_APPROVED');
    if (safetyApproved) {
      assert('SAFETY_APPROVED 项 next_role = admin', safetyApproved.next_role === 'admin');
      assert('SAFETY_APPROVED 项 next_role_label = 发布', safetyApproved.next_role_label === '发布');
    }
  }
  assert('admin filters.role_scope 正确',
    rAdmin.body && rAdmin.body.data && rAdmin.body.data.filters && rAdmin.body.data.filters.role_scope === 'admin: 全部待处理');

  // =====================================================
  section('场景 4：角色权限 —— 普通老师只能看到本人未结束的申请');

  const rTeacher1 = await request('GET', '/api/applications/reminders', null, { 'X-User-Id': '1' });
  assert('张老师(id=1)查询返回 200', rTeacher1.status === 200);
  assert('张老师 items 含 2 条（本人两条：app1_pending PENDING_SUBMITTED、app3_safety SAFETY_APPROVED）',
    rTeacher1.body && rTeacher1.body.data && rTeacher1.body.data.items.length === 2,
    '实际=' + (rTeacher1.body && rTeacher1.body.data ? rTeacher1.body.data.items.length : 'N/A'));
  if (rTeacher1.body && rTeacher1.body.data) {
    const allMine = rTeacher1.body.data.items.every(i => i.applicant_id === 1);
    assert('张老师命中项 applicant_id 均为 1', allMine);
  }
  assert('老师 filters.role_scope 正确',
    rTeacher1.body && rTeacher1.body.data && rTeacher1.body.data.filters && rTeacher1.body.data.filters.role_scope === 'teacher: 本人未结束的申请');

  const rTeacher2 = await request('GET', '/api/applications/reminders', null, { 'X-User-Id': '2' });
  assert('李老师(id=2)查询返回 200', rTeacher2.status === 200);
  assert('李老师 items 含 1 条（仅本人的 app2_pending DISPATCH_REVIEWED）',
    rTeacher2.body && rTeacher2.body.data && rTeacher2.body.data.items.length === 1,
    '实际=' + (rTeacher2.body && rTeacher2.body.data ? rTeacher2.body.data.items.length : 'N/A'));
  if (rTeacher2.body && rTeacher2.body.data && rTeacher2.body.data.items[0]) {
    assert('李老师命中项 applicant_id = 2', rTeacher2.body.data.items[0].applicant_id === 2);
  }

  // =====================================================
  section('场景 5：筛选 —— timeout_status=overdue 只返回已超时');

  setApplicationUpdatedAt(app1_pending, 120);
  setApplicationUpdatedAt(app2_pending, 10);

  const rOverdue = await request('GET', '/api/applications/reminders?timeout_status=overdue', null, { 'X-User-Id': '5' });
  assert('admin 查 overdue 返回 200', rOverdue.status === 200);
  if (rOverdue.body && rOverdue.body.data) {
    const allOverdue = rOverdue.body.data.items.every(i => i.is_overdue === true);
    assert('overdue 筛选后所有项 is_overdue=true', allOverdue);
    assert('overdue 筛选后 overdue_count = total', rOverdue.body.data.overdue_count === rOverdue.body.data.total);
    assert('overdue 筛选命中至少 1 条', rOverdue.body.data.total >= 1, '实际=' + rOverdue.body.data.total);
    rOverdue.body.data.items.forEach(i => {
      assert('overdue 项 minutes_to_timeout <= 0', i.minutes_to_timeout <= 0, 'id=' + i.id + ', val=' + i.minutes_to_timeout);
    });
  }

  // =====================================================
  section('场景 6：筛选 —— timeout_status=pending 只返回即将超时（未超时）');

  const rPending = await request('GET', '/api/applications/reminders?timeout_status=pending', null, { 'X-User-Id': '5' });
  assert('admin 查 pending 返回 200', rPending.status === 200);
  if (rPending.body && rPending.body.data) {
    const noneOverdue = rPending.body.data.items.every(i => i.is_overdue === false);
    assert('pending 筛选后所有项 is_overdue=false', noneOverdue);
    assert('pending 筛选后 warning_count = total', rPending.body.data.warning_count === rPending.body.data.total);
    rPending.body.data.items.forEach(i => {
      assert('pending 项 minutes_to_timeout > 0', i.minutes_to_timeout > 0, 'id=' + i.id + ', val=' + i.minutes_to_timeout);
    });
  }

  // =====================================================
  section('场景 7：筛选 —— route_name 模糊匹配');

  const rRoute = await request('GET', '/api/applications/reminders?route_name=提醒测试线-A', null, { 'X-User-Id': '5' });
  assert('按线路筛选返回 200', rRoute.status === 200);
  assert('按线路筛选命中 1 条',
    rRoute.body && rRoute.body.data && rRoute.body.data.items.length === 1,
    '实际=' + (rRoute.body && rRoute.body.data ? rRoute.body.data.items.length : 'N/A'));
  if (rRoute.body && rRoute.body.data && rRoute.body.data.items[0]) {
    assert('命中项线路名称正确', rRoute.body.data.items[0].route_name.indexOf('提醒测试线-A') !== -1);
    assert('filters 记录 route_name', rRoute.body.data.filters && rRoute.body.data.filters.route_name === '提醒测试线-A');
  }

  // =====================================================
  section('场景 8：筛选 —— status 精确匹配');

  const rStatus = await request('GET', '/api/applications/reminders?status=PENDING_SUBMITTED', null, { 'X-User-Id': '5' });
  assert('按状态筛选返回 200', rStatus.status === 200);
  if (rStatus.body && rStatus.body.data) {
    const allMatch = rStatus.body.data.items.every(i => i.status === 'PENDING_SUBMITTED');
    assert('状态筛选后所有项 status = PENDING_SUBMITTED', allMatch, '状态=' + rStatus.body.data.items.map(i => i.status).join(','));
    assert('filters 记录 status', rStatus.body.data.filters && rStatus.body.data.filters.status === 'PENDING_SUBMITTED');
  }

  // =====================================================
  section('场景 9：空结果');

  const app4_published = await createApplication(1, '-D');
  await advanceTo(app4_published, 'PUBLISHED');
  const app5_rejected = await createApplication(2, '-E');
  await advanceTo(app5_rejected, 'REJECTED');

  setApplicationUpdatedAt(app1_pending, 0);
  setApplicationUpdatedAt(app2_pending, 0);
  setApplicationUpdatedAt(app3_safety, 0);

  const rDispatchEmpty = await request('GET', '/api/applications/reminders?route_name=不存在的线路', null, { 'X-User-Id': '3' });
  assert('空结果（筛选不出）返回 200', rDispatchEmpty.status === 200);
  assert('空结果 items 为空数组',
    rDispatchEmpty.body && rDispatchEmpty.body.data && Array.isArray(rDispatchEmpty.body.data.items) && rDispatchEmpty.body.data.items.length === 0);
  assert('空结果 total = 0', rDispatchEmpty.body && rDispatchEmpty.body.data && rDispatchEmpty.body.data.total === 0);
  assert('空结果 overdue_count = 0', rDispatchEmpty.body && rDispatchEmpty.body.data && rDispatchEmpty.body.data.overdue_count === 0);
  assert('空结果 warning_count = 0', rDispatchEmpty.body && rDispatchEmpty.body.data && rDispatchEmpty.body.data.warning_count === 0);

  // =====================================================
  section('场景 10：审计日志落盘（每次查询都写）');

  const auditCountBefore = countAuditLogsByAction('APPLICATION_REMINDERS_QUERY');
  const rAuditTest = await request('GET', '/api/applications/reminders?timeout_status=all', null, { 'X-User-Id': '5' });
  const auditCountAfter = countAuditLogsByAction('APPLICATION_REMINDERS_QUERY');
  assert('查询后 audit_logs APPLICATION_REMINDERS_QUERY 增加 1 条',
    auditCountAfter === auditCountBefore + 1,
    'before=' + auditCountBefore + ', after=' + auditCountAfter);

  const latestAudit = getLatestAuditLog('APPLICATION_REMINDERS_QUERY');
  assert('最新审计日志存在', !!latestAudit);
  if (latestAudit) {
    assert('审计日志 user_id = 5 (admin)', latestAudit.user_id === 5);
    assert('审计日志 resource 正确', latestAudit.resource && latestAudit.resource.indexOf('/reminders') !== -1);
    assert('审计日志 detail 是对象', latestAudit.detail && typeof latestAudit.detail === 'object');
    if (latestAudit.detail) {
      assert('detail 含 operator_id=5', latestAudit.detail.operator_id === 5);
      assert('detail 含 operator_role=admin', latestAudit.detail.operator_role === 'admin');
      assert('detail 含 filters 对象', typeof latestAudit.detail.filters === 'object');
      assert('detail 含 hit_count 数字', typeof latestAudit.detail.hit_count === 'number');
      assert('detail 含 timeout_minutes=60', latestAudit.detail.timeout_minutes === 60);
      assert('detail 含 overdue_count 数字', typeof latestAudit.detail.overdue_count === 'number');
      assert('detail 含 warning_count 数字', typeof latestAudit.detail.warning_count === 'number');
    }
  }

  // =====================================================
  section('场景 11：阈值配置生效 —— 环境变量 APPROVAL_TIMEOUT_MINUTES=5');

  console.log('  停止服务...');
  await stopServer();
  await new Promise(r => setTimeout(r, 500));
  console.log('  以 APPROVAL_TIMEOUT_MINUTES=5 重新启动服务...');
  await startServer(5);
  await waitForHealth();
  console.log('  服务已重启');

  setApplicationUpdatedAt(app1_pending, 10);

  const rCustomThreshold = await request('GET', '/api/applications/reminders', null, { 'X-User-Id': '3' });
  assert('自定义阈值下查询返回 200', rCustomThreshold.status === 200);
  assert('timeout_minutes = 5（环境变量生效）',
    rCustomThreshold.body && rCustomThreshold.body.data && rCustomThreshold.body.data.timeout_minutes === 5,
    '实际=' + (rCustomThreshold.body && rCustomThreshold.body.data ? rCustomThreshold.body.data.timeout_minutes : 'N/A'));
  if (rCustomThreshold.body && rCustomThreshold.body.data && rCustomThreshold.body.data.items.length > 0) {
    const item = rCustomThreshold.body.data.items[0];
    assert('10分钟前更新的申请在阈值5下 is_overdue=true', item.is_overdue === true, '实际=' + item.is_overdue);
    assert('minutes_to_timeout 为负值', item.minutes_to_timeout < 0, '实际=' + item.minutes_to_timeout);
  }

  // =====================================================
  section('场景 12：非法阈值回退到缺省值 60');

  console.log('  停止服务...');
  await stopServer();
  await new Promise(r => setTimeout(r, 500));
  console.log('  以 APPROVAL_TIMEOUT_MINUTES=abc（非法值）重新启动服务...');
  await startServer('abc');
  await waitForHealth();
  console.log('  服务已重启');

  const rInvalidThreshold = await request('GET', '/api/applications/reminders', null, { 'X-User-Id': '3' });
  assert('非法阈值下查询返回 200', rInvalidThreshold.status === 200);
  assert('非法值回退到 timeout_minutes = 60',
    rInvalidThreshold.body && rInvalidThreshold.body.data && rInvalidThreshold.body.data.timeout_minutes === 60,
    '实际=' + (rInvalidThreshold.body && rInvalidThreshold.body.data ? rInvalidThreshold.body.data.timeout_minutes : 'N/A'));

  // =====================================================
  section('场景 13：重启后审计日志仍可查，阈值重新读取');

  const auditCountAfterRestart = countAuditLogsByAction('APPLICATION_REMINDERS_QUERY');
  assert('重启后审计日志条数仍 >= 1', auditCountAfterRestart >= 1, '实际=' + auditCountAfterRestart);

  const latestAfterRestart = getLatestAuditLog('APPLICATION_REMINDERS_QUERY');
  assert('重启后仍能读到最新审计日志', !!latestAfterRestart);

  console.log('  停止服务...');
  await stopServer();
  await new Promise(r => setTimeout(r, 500));
  console.log('  以默认阈值重启（验证配置每次从环境变量读取）...');
  await startServer();
  await waitForHealth();
  console.log('  服务已重启');

  const rDefaultAgain = await request('GET', '/api/applications/reminders', null, { 'X-User-Id': '5' });
  assert('重启后阈值恢复默认 60',
    rDefaultAgain.body && rDefaultAgain.body.data && rDefaultAgain.body.data.timeout_minutes === 60,
    '实际=' + (rDefaultAgain.body && rDefaultAgain.body.data ? rDefaultAgain.body.data.timeout_minutes : 'N/A'));

  const auditCountFinal = countAuditLogsByAction('APPLICATION_REMINDERS_QUERY');
  assert('重启后再查询，审计日志继续累加', auditCountFinal > auditCountAfterRestart,
    'before=' + auditCountAfterRestart + ', after=' + auditCountFinal);

  // =====================================================
  section('场景 14：未认证调用返回 401');

  const rNoAuth = await request('GET', '/api/applications/reminders');
  assert('未认证返回 401', rNoAuth.status === 401);
  assert('未认证错误码 AUTH_REQUIRED', rNoAuth.body && rNoAuth.body.code === 'AUTH_REQUIRED');

  // =====================================================
  section('场景 15：响应结构与现有接口一致');

  assert('成功响应结构一致（success/code/message/data/timestamp）',
    rDefaultAgain.body &&
    'success' in rDefaultAgain.body &&
    'code' in rDefaultAgain.body &&
    'message' in rDefaultAgain.body &&
    'data' in rDefaultAgain.body &&
    'timestamp' in rDefaultAgain.body &&
    rDefaultAgain.body.success === true &&
    rDefaultAgain.body.code === 'OK');

  assert('data 顶层包含 timeout_minutes/total/overdue_count/warning_count/filters/items',
    rDefaultAgain.body && rDefaultAgain.body.data &&
    'timeout_minutes' in rDefaultAgain.body.data &&
    'total' in rDefaultAgain.body.data &&
    'overdue_count' in rDefaultAgain.body.data &&
    'warning_count' in rDefaultAgain.body.data &&
    'filters' in rDefaultAgain.body.data &&
    'items' in rDefaultAgain.body.data);

  // =====================================================
  section('测试汇总');

  console.log('\n通过: ' + pass + ' / ' + (pass + fail));
  console.log('失败: ' + fail + ' / ' + (pass + fail));

  if (fail > 0) {
    console.log('\n失败用例:');
    results.filter(r => !r.ok).forEach(r => console.log('  ❌ ' + r.label + (r.detail ? ' — ' + r.detail : '')));
  } else {
    console.log('\n✅ 全部通过！');
  }

  await stopServer();
  process.exit(fail > 0 ? 1 : 0);
})().catch(async (e) => {
  console.error('\n测试执行出错:', e);
  try { await stopServer(); } catch (_) { }
  process.exit(1);
});
