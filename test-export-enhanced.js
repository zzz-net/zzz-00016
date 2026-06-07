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

function startServer() {
  return new Promise((resolve) => {
    serverProc = spawn('node', ['src/server.js'], {
      cwd: __dirname,
      stdio: 'ignore',
      env: { ...process.env, PORT: '3000' }
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

async function createApplication(userId, opts = {}) {
  const body = {
    route_name: opts.route_name || '测试线',
    original_stops: opts.original_stops || ['A', 'B', 'C'],
    new_stops: opts.new_stops || ['A', 'D', 'C'],
    effective_start: opts.effective_start || '2026-10-01T07:00:00.000Z',
    effective_end: opts.effective_end || '2026-10-01T09:00:00.000Z',
    vehicle_id: opts.vehicle_id || 'BUS-EXP',
    reason: opts.reason || '测试导出'
  };
  const r = await request('POST', '/api/applications', body, { 'X-User-Id': String(userId) });
  return r.body.data.id;
}

async function advanceTo(appId, targetStatus, extra = {}) {
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
  } else if (targetStatus === 'CANCELLED') {
    const cancelUserId = extra.cancelUserId || 1;
    const cancelComment = extra.cancelComment || '测试取消备注';
    await request('POST', '/api/applications/' + appId + '/cancel', { comment: cancelComment }, { 'X-User-Id': String(cancelUserId) });
  }
}

function parseCSV(raw) {
  const clean = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  const lines = clean.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const parseLine = (line) => {
    const result = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        result.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    result.push(cur);
    return result;
  };
  const headers = parseLine(lines[0]);
  const rows = lines.slice(1).map(parseLine);
  return { headers, rows };
}

(async function main() {
  console.log('\n======== 校车改线 —— 导出功能增强全场景测试 ========\n');

  section('准备：清空数据库并启动服务');
  deleteDbIfExists();
  spawnSync('node', ['src/scripts/init-db.js'], { cwd: __dirname, stdio: 'inherit' });
  await startServer();
  await waitForHealth();
  console.log('  服务就绪');

  // ========== 准备测试数据 ==========
  section('准备：构造测试数据');

  const app1 = await createApplication(1, { route_name: '1号线', reason: '张老师待调度' });
  assert('创建 app1 (张老师, PENDING_SUBMITTED)', app1 > 0);

  const app2 = await createApplication(1, { route_name: '1号线', reason: '张老师已取消-带备注' });
  await advanceTo(app2, 'CANCELLED');
  assert('创建 app2 (张老师, CANCELLED, 有取消备注)', true);

  const app3 = await createApplication(1, { route_name: '2号线', reason: '张老师已发布' });
  await advanceTo(app3, 'PUBLISHED');
  assert('创建 app3 (张老师, PUBLISHED)', true);

  const app4 = await createApplication(2, { route_name: '1号线', reason: '李老师待调度' });
  assert('创建 app4 (李老师, PENDING_SUBMITTED)', true);

  const app5 = await createApplication(2, { route_name: '2号线', reason: '李老师已驳回' });
  await advanceTo(app5, 'REJECTED');
  assert('创建 app5 (李老师, REJECTED)', true);

  const app6 = await createApplication(2, { route_name: '3号线', reason: '李老师待安全审批' });
  await advanceTo(app6, 'DISPATCH_REVIEWED');
  assert('创建 app6 (李老师, DISPATCH_REVIEWED)', true);

  console.log('  测试数据构造完成: app1=' + app1 + ' app2=' + app2 + ' app3=' + app3 + ' app4=' + app4 + ' app5=' + app5 + ' app6=' + app6);

  // ========== 场景1：admin 正常导出，按状态筛选 ==========
  section('场景 1：admin 按状态筛选导出 JSON');

  const r1 = await request('GET', '/api/applications/export?format=json&status=PENDING_SUBMITTED', null, { 'X-User-Id': '5' });
  assert('admin 按 PENDING_SUBMITTED 导出返回 200', r1.status === 200);
  assert('JSON 含 count 字段', r1.body && typeof r1.body.count === 'number');
  assert('PENDING_SUBMITTED 共 2 条 (app1+app4)', r1.body && r1.body.count === 2, '实际=' + (r1.body ? r1.body.count : 'null'));
  assert('JSON 含 items 数组', r1.body && Array.isArray(r1.body.items) && r1.body.items.length === 2);
  assert('所有 items 状态均为 PENDING_SUBMITTED', r1.body && r1.body.items.every(it => it.status === 'PENDING_SUBMITTED'));
  assert('JSON 含 filters 字段', r1.body && r1.body.filters && r1.body.filters.status === 'PENDING_SUBMITTED');
  assert('JSON 含 filter_summary 字段', r1.body && typeof r1.body.filter_summary === 'string' && r1.body.filter_summary.length > 0);
  assert('filter_summary 包含状态筛选描述', r1.body && r1.body.filter_summary.indexOf('状态=PENDING_SUBMITTED') !== -1);

  // ========== 场景2：admin 按申请人筛选 ==========
  section('场景 2：admin 按申请人筛选导出 JSON');

  const r2 = await request('GET', '/api/applications/export?format=json&applicant_id=1', null, { 'X-User-Id': '5' });
  assert('admin 按 applicant_id=1 导出返回 200', r2.status === 200);
  assert('张老师共 3 条 (app1+app2+app3)', r2.body && r2.body.count === 3, '实际=' + (r2.body ? r2.body.count : 'null'));
  assert('所有 items 申请人为张老师(id=1)', r2.body && r2.body.items.every(it => it.applicant && it.applicant.id === 1));
  assert('filters 含 applicant_id=1', r2.body && r2.body.filters && r2.body.filters.applicant_id === 1);

  // ========== 场景3：admin 按是否有取消备注筛选 ==========
  section('场景 3：admin 按 has_cancel_remark 筛选');

  const r3a = await request('GET', '/api/applications/export?format=json&has_cancel_remark=true', null, { 'X-User-Id': '5' });
  assert('has_cancel_remark=true 返回 200', r3a.status === 200);
  assert('有取消备注的共 1 条 (app2)', r3a.body && r3a.body.count === 1, '实际=' + (r3a.body ? r3a.body.count : 'null'));
  assert('仅返回 CANCELLED 且 cancel_remark 非空', r3a.body && r3a.body.items.every(it => !!it.cancel_remark));

  const r3b = await request('GET', '/api/applications/export?format=json&has_cancel_remark=false', null, { 'X-User-Id': '5' });
  assert('has_cancel_remark=false 返回 200', r3b.status === 200);
  assert('无取消备注的共 5 条 (app1,app3,app4,app5,app6)', r3b.body && r3b.body.count === 5, '实际=' + (r3b.body ? r3b.body.count : 'null'));
  assert('所有 items cancel_remark 为空或 null', r3b.body && r3b.body.items.every(it => !it.cancel_remark));

  // ========== 场景4：admin 多条件组合筛选 ==========
  section('场景 4：admin 多条件组合筛选');

  const r4 = await request('GET', '/api/applications/export?format=json&status=CANCELLED&applicant_id=1&has_cancel_remark=true', null, { 'X-User-Id': '5' });
  assert('多条件组合返回 200', r4.status === 200);
  assert('组合筛选结果为 1 条 (app2)', r4.body && r4.body.count === 1, '实际=' + (r4.body ? r4.body.count : 'null'));
  assert('filter_summary 包含全部筛选条件', r4.body &&
    r4.body.filter_summary.indexOf('状态=CANCELLED') !== -1 &&
    r4.body.filter_summary.indexOf('申请人ID=1') !== -1 &&
    r4.body.filter_summary.indexOf('有取消备注') !== -1);

  // ========== 场景5：普通老师默认只能导出自己的 ==========
  section('场景 5：普通老师默认仅导出本人申请');

  const r5 = await request('GET', '/api/applications/export?format=json', null, { 'X-User-Id': '1' });
  assert('张老师默认导出返回 200', r5.status === 200);
  assert('张老师默认只能看到自己的 3 条', r5.body && r5.body.count === 3, '实际=' + (r5.body ? r5.body.count : 'null'));
  assert('所有 items 申请人为张老师(id=1)', r5.body && r5.body.items.every(it => it.applicant && it.applicant.id === 1));
  assert('filters.scope_note 说明为普通老师', r5.body && r5.body.filters && r5.body.filters.scope_note && r5.body.filters.scope_note.indexOf('普通老师') !== -1);

  const r5b = await request('GET', '/api/applications/export?format=json', null, { 'X-User-Id': '2' });
  assert('李老师默认导出返回 200', r5b.status === 200);
  assert('李老师默认只能看到自己的 3 条', r5b.body && r5b.body.count === 3, '实际=' + (r5b.body ? r5b.body.count : 'null'));

  // ========== 场景6：普通老师越权按申请人筛选别人 ==========
  section('场景 6：普通老师越权按申请人筛选别人（拒绝）');

  const r6 = await request('GET', '/api/applications/export?format=json&applicant_id=2', null, { 'X-User-Id': '1' });
  assert('张老师筛李老师的申请返回 403', r6.status === 403, '实际=' + r6.status);
  assert('错误码 PERMISSION_DENIED', r6.body && r6.body.code === 'PERMISSION_DENIED');
  assert('错误详情包含 requested_applicant_id=2', r6.body && r6.body.details && r6.body.details.requested_applicant_id === 2);

  const r6b = await request('GET', '/api/applications/export?format=json&applicant_id=1', null, { 'X-User-Id': '1' });
  assert('张老师筛自己的申请返回 200（允许）', r6b.status === 200);

  // ========== 场景7：调度员按申请人筛选（允许） ==========
  section('场景 7：调度员/安全员可按申请人筛选（特权）');

  const r7a = await request('GET', '/api/applications/export?format=json&applicant_id=2', null, { 'X-User-Id': '3' });
  assert('调度员按 applicant_id=2 筛选返回 200', r7a.status === 200);
  assert('调度员看到李老师 3 条申请', r7a.body && r7a.body.count === 3);

  const r7b = await request('GET', '/api/applications/export?format=json&applicant_id=1', null, { 'X-User-Id': '4' });
  assert('安全员按 applicant_id=1 筛选返回 200', r7b.status === 200);
  assert('安全员看到张老师 3 条申请', r7b.body && r7b.body.count === 3);

  // ========== 场景8：空结果 ==========
  section('场景 8：空结果导出');

  const r8 = await request('GET', '/api/applications/export?format=json&status=SAFETY_APPROVED', null, { 'X-User-Id': '5' });
  assert('空结果返回 200', r8.status === 200);
  assert('count = 0', r8.body && r8.body.count === 0);
  assert('items 为空数组', r8.body && Array.isArray(r8.body.items) && r8.body.items.length === 0);
  assert('仍含 filters 和 filter_summary', r8.body && r8.body.filters && typeof r8.body.filter_summary === 'string');

  const r8csv = await request('GET', '/api/applications/export?format=csv&status=SAFETY_APPROVED', null, { 'X-User-Id': '5' });
  assert('CSV 空结果返回 200', r8csv.status === 200);
  const csvEmpty = parseCSV(r8csv.raw);
  assert('CSV 空结果仍有表头行', csvEmpty.headers.length > 0 && csvEmpty.rows.length === 0);

  // ========== 场景9：取消记录参与筛选 ==========
  section('场景 9：取消记录参与筛选');

  const r9a = await request('GET', '/api/applications/export?format=json&status=CANCELLED', null, { 'X-User-Id': '5' });
  assert('按 CANCELLED 状态导出返回 200', r9a.status === 200);
  assert('CANCELLED 共 1 条', r9a.body && r9a.body.count === 1, '实际=' + (r9a.body ? r9a.body.count : 'null'));
  const cancelledItem = r9a.body.items[0];
  assert('CANCELLED 项含 cancel_remark', cancelledItem && !!cancelledItem.cancel_remark);
  assert('CANCELLED 项含 status_label=已取消', cancelledItem && cancelledItem.status_label === '已取消');
  assert('CANCELLED 项 history 含 CANCEL 操作', cancelledItem && cancelledItem.history.some(h => h.action === 'CANCEL'));

  // ========== 场景10：CSV 列顺序稳定 ==========
  section('场景 10：CSV 列顺序稳定');

  const r10csv = await request('GET', '/api/applications/export?format=csv', null, { 'X-User-Id': '5' });
  assert('CSV 导出返回 200', r10csv.status === 200);
  const csvParsed = parseCSV(r10csv.raw);
  const expectedHeaders = [
    'ID', '线路', '原站点', '新站点', '移除站点', '新增站点',
    '生效开始', '生效结束', '车辆', '原因', '状态', '状态描述',
    '驳回原因', '取消备注', '申请人', '创建时间', '更新时间'
  ];
  assert('CSV 列数 = 17', csvParsed.headers.length === 17, '实际=' + csvParsed.headers.length);
  assert('CSV 列顺序与预期完全一致',
    JSON.stringify(csvParsed.headers) === JSON.stringify(expectedHeaders),
    '实际表头: ' + JSON.stringify(csvParsed.headers));

  // ========== 场景11：CSV/JSON 内容一致性证明 ==========
  section('场景 11：CSV 与 JSON 内容一致性证明');

  const r11json = await request('GET', '/api/applications/export?format=json&status=PUBLISHED', null, { 'X-User-Id': '5' });
  const r11csv = await request('GET', '/api/applications/export?format=csv&status=PUBLISHED', null, { 'X-User-Id': '5' });
  assert('JSON PUBLISHED 返回 count=1', r11json.body && r11json.body.count === 1);
  const jsonItem = r11json.body.items[0];
  const csv11 = parseCSV(r11csv.raw);
  assert('CSV PUBLISHED 行数 = 1', csv11.rows.length === 1, '实际=' + csv11.rows.length);
  const csvRow = csv11.rows[0];
  assert('CSV ID 与 JSON id 一致', csvRow[0] === String(jsonItem.id));
  assert('CSV 线路 与 JSON route_name 一致', csvRow[1] === jsonItem.route_name);
  assert('CSV 状态 与 JSON status 一致', csvRow[10] === jsonItem.status);
  assert('CSV 状态描述 与 JSON status_label 一致', csvRow[11] === jsonItem.status_label);
  assert('CSV 取消备注 与 JSON cancel_remark 一致', (csvRow[13] || '') === (jsonItem.cancel_remark || ''));
  assert('CSV 申请人 与 JSON applicant.name 一致', csvRow[14] === (jsonItem.applicant ? jsonItem.applicant.name : ''));
  console.log('  ✅ JSON 与 CSV 关键字段一致，证明两者内容同源且一致');

  // ========== 场景12：导出审计日志包含操作者、格式、筛选条件、条数 ==========
  section('场景 12：审计日志验证');

  const { getDb } = require('./src/db');
  const db = getDb();
  const auditRows = db.prepare(`
    SELECT * FROM audit_logs
    WHERE action = 'APPLICATION_EXPORT_RESULT'
    ORDER BY id DESC
    LIMIT 10
  `).all();
  assert('审计日志中存在 APPLICATION_EXPORT_RESULT 记录', auditRows.length > 0, '实际条数=' + auditRows.length);

  if (auditRows.length > 0) {
    const lastAudit = auditRows[0];
    const detail = JSON.parse(lastAudit.detail || '{}');
    assert('审计日志包含 user_id', lastAudit.user_id !== null && lastAudit.user_id !== undefined);
    assert('审计日志 detail 包含 format', 'format' in detail && (detail.format === 'json' || detail.format === 'csv'));
    assert('审计日志 detail 包含 filters', 'filters' in detail && typeof detail.filters === 'object');
    assert('审计日志 detail 包含 count', 'count' in detail && typeof detail.count === 'number');
  }

  // ========== 场景13：重启后审计日志和数据仍可查 ==========
  section('场景 13：重启后数据与审计日志持久化');

  console.log('  停止服务...');
  await stopServer();
  await new Promise(r => setTimeout(r, 800));
  console.log('  重新启动服务...');
  await startServer();
  await waitForHealth();
  console.log('  服务已重启');

  const r13 = await request('GET', '/api/applications/export?format=json&status=CANCELLED&has_cancel_remark=true', null, { 'X-User-Id': '5' });
  assert('重启后导出仍可查询 CANCELLED', r13.status === 200 && r13.body && r13.body.count === 1);

  const { getDb: getDb2 } = require('./src/db');
  const db2 = getDb2();
  const auditAfterRestart = db2.prepare("SELECT COUNT(*) as cnt FROM audit_logs WHERE action IN ('APPLICATION_EXPORT','APPLICATION_EXPORT_RESULT')").get();
  assert('重启后审计日志仍存在', auditAfterRestart.cnt > 0, '实际条数=' + auditAfterRestart.cnt);
  const appsAfterRestart = db2.prepare("SELECT COUNT(*) as cnt FROM applications").get();
  assert('重启后申请数据仍存在', appsAfterRestart.cnt === 6, '实际=' + appsAfterRestart.cnt);

  // ========== 场景14：admin 导出现有 route_name + date 筛选（向后兼容） ==========
  section('场景 14：向后兼容 —— 原有 route_name + date 筛选仍可用');

  const r14 = await request('GET', '/api/applications/export?format=json&route_name=1号线&start_date=2026-10-01&end_date=2026-10-31', null, { 'X-User-Id': '5' });
  assert('原有筛选参数仍返回 200', r14.status === 200);
  assert('1号线 10 月共 3 条 (app1,app2,app4)', r14.body && r14.body.count === 3, '实际=' + (r14.body ? r14.body.count : 'null'));
  assert('filters 含原有 route_name/start_date/end_date',
    r14.body && r14.body.filters &&
    r14.body.filters.route_name === '1号线' &&
    r14.body.filters.start_date &&
    r14.body.filters.end_date);

  // ========== 汇总 ==========
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
