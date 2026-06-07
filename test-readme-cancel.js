const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const BASE = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, 'data', 'school-bus.db');

let pass = 0;
let fail = 0;

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
    console.log('  PASS: ' + label + (detail ? ' — ' + detail : ''));
  } else {
    fail++;
    console.log('  FAIL: ' + label + (detail ? ' — ' + detail : ''));
  }
}

function deleteDbIfExists() {
  if (fs.existsSync(DB_PATH)) { try { fs.unlinkSync(DB_PATH); } catch (e) {} }
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
    } else { resolve(); }
  });
}

async function waitForHealth() {
  for (let i = 0; i < 30; i++) {
    try { const r = await request('GET', '/health'); if (r.status === 200) return; } catch (e) {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('Server not ready');
}

function hasErrorShape(b) {
  return b && 'success' in b && 'code' in b && 'message' in b && 'details' in b && 'timestamp' in b && b.success === false;
}

function hasSuccessShape(b) {
  return b && b.success === true && b.code === 'OK' && 'message' in b && 'data' in b && 'timestamp' in b;
}

(async () => {
  console.log('\n======== README 取消接口文档一致性校验 ========\n');
  deleteDbIfExists();
  spawnSync('node', ['src/scripts/init-db.js'], { cwd: __dirname, stdio: 'inherit' });
  await startServer();
  await waitForHealth();

  // ===== 文档 7. 取消申请：本人取消（带备注） =====
  console.log('\n--- 文档：本人取消（带备注） ---');
  const createR = await request('POST', '/api/applications', {
    route_name: '1号线',
    original_stops: ['东门站', '少年宫站', '图书馆站', '学校站'],
    new_stops: ['东门站', '人民广场站', '体育馆站', '学校站'],
    effective_start: '2026-06-10T07:00:00.000Z',
    effective_end: '2026-06-10T09:00:00.000Z',
    vehicle_id: 'BUS-A01',
    reason: '少年宫路段道路施工，临时绕行'
  }, { 'X-User-Id': '1' });
  const appId = createR.body.data.id;

  const selfCancelR = await request('POST', '/api/applications/' + appId + '/cancel',
    { comment: '计划有变，暂不需要改线' }, { 'X-User-Id': '1' });

  assert('本人取消 HTTP 200', selfCancelR.status === 200);
  assert('成功响应五字段结构（success/code/message/data/timestamp）', hasSuccessShape(selfCancelR.body));
  assert('message = "取消成功"', selfCancelR.body.message === '取消成功');
  assert('data.status = CANCELLED', selfCancelR.body.data.status === 'CANCELLED');
  assert('data.status_label = 已取消', selfCancelR.body.data.status_label === '已取消');
  assert('data.cancel_remark = 文档给出的备注', selfCancelR.body.data.cancel_remark === '计划有变，暂不需要改线');
  assert('data 含 history 数组', Array.isArray(selfCancelR.body.data.history));
  const cancelHist = selfCancelR.body.data.history.find(h => h.action === 'CANCEL');
  assert('history 含 action=CANCEL', !!cancelHist);
  assert('CANCEL.from_status = PENDING_SUBMITTED', cancelHist && cancelHist.from_status === 'PENDING_SUBMITTED');
  assert('CANCEL.to_status = CANCELLED', cancelHist && cancelHist.to_status === 'CANCELLED');
  assert('CANCEL.comment = 备注', cancelHist && cancelHist.comment === '计划有变，暂不需要改线');
  assert('CANCEL.operator.id = 1（申请人本人）', cancelHist && cancelHist.operator && cancelHist.operator.id === 1);

  // ===== 文档 7. 取消申请：本人取消（缺省备注） =====
  console.log('\n--- 文档：本人取消（缺省备注） ---');
  const createR2 = await request('POST', '/api/applications', {
    route_name: '缺省备注线',
    original_stops: ['A', 'B'], new_stops: ['A', 'C'],
    effective_start: '2026-10-01T07:00:00.000Z', effective_end: '2026-10-01T09:00:00.000Z',
    reason: 't'
  }, { 'X-User-Id': '1' });
  const appId2 = createR2.body.data.id;

  const selfDefaultR = await request('POST', '/api/applications/' + appId2 + '/cancel', null, { 'X-User-Id': '1' });
  assert('本人缺省备注取消 HTTP 200', selfDefaultR.status === 200);
  assert('文档：本人取消缺省备注 = "申请人取消"', selfDefaultR.body.data.cancel_remark === '申请人取消');

  // ===== 文档 7. 取消申请：admin 代取消（带备注） =====
  console.log('\n--- 文档：admin 代取消（带备注） ---');
  const createR3 = await request('POST', '/api/applications', {
    route_name: 'admin取消线',
    original_stops: ['A', 'B'], new_stops: ['A', 'C'],
    effective_start: '2026-11-01T07:00:00.000Z', effective_end: '2026-11-01T09:00:00.000Z',
    reason: 't'
  }, { 'X-User-Id': '2' });
  const appId3 = createR3.body.data.id;

  const adminCancelR = await request('POST', '/api/applications/' + appId3 + '/cancel',
    { comment: '管理员核实后代为取消' }, { 'X-User-Id': '5' });
  assert('admin 代取消 HTTP 200', adminCancelR.status === 200);
  assert('admin 代取消状态 CANCELLED', adminCancelR.body.data.status === 'CANCELLED');
  assert('admin 代取消 cancel_remark 匹配文档', adminCancelR.body.data.cancel_remark === '管理员核实后代为取消');
  const adminHist = adminCancelR.body.data.history.find(h => h.action === 'CANCEL');
  assert('CANCEL.operator.id = 5（admin）', adminHist && adminHist.operator && adminHist.operator.id === 5);
  assert('CANCEL.operator.role = admin', adminHist && adminHist.operator && adminHist.operator.role === 'admin');

  // ===== 文档 7. 取消申请：admin 代取消（缺省备注） =====
  console.log('\n--- 文档：admin 代取消（缺省备注） ---');
  const createR4 = await request('POST', '/api/applications', {
    route_name: 'admin缺省线',
    original_stops: ['A', 'B'], new_stops: ['A', 'C'],
    effective_start: '2026-12-01T07:00:00.000Z', effective_end: '2026-12-01T09:00:00.000Z',
    reason: 't'
  }, { 'X-User-Id': '2' });
  const appId4 = createR4.body.data.id;

  const adminDefaultR = await request('POST', '/api/applications/' + appId4 + '/cancel', null, { 'X-User-Id': '5' });
  assert('admin 缺省备注 = "管理员代取消"（文档承诺）', adminDefaultR.body.data.cancel_remark === '管理员代取消');

  // ===== 文档 E1. 越权取消（其他老师） =====
  console.log('\n--- 文档 E1：越权取消（李老师取消张老师的申请） ---');
  const createR5 = await request('POST', '/api/applications', {
    route_name: '越权测试线',
    original_stops: ['A', 'B'], new_stops: ['A', 'C'],
    effective_start: '2027-01-01T07:00:00.000Z', effective_end: '2027-01-01T09:00:00.000Z',
    reason: 't'
  }, { 'X-User-Id': '1' });
  const appId5 = createR5.body.data.id;

  const permR = await request('POST', '/api/applications/' + appId5 + '/cancel',
    { comment: '恶意取消' }, { 'X-User-Id': '2' });
  assert('越权取消 HTTP 403', permR.status === 403);
  assert('越权错误五字段结构（success/code/message/details/timestamp）', hasErrorShape(permR.body));
  assert('code = PERMISSION_DENIED', permR.body.code === 'PERMISSION_DENIED');
  assert('message 与文档一致', permR.body.message === '无权取消该申请，仅申请人本人或管理员可取消');
  assert('details.applicant_id = 1', permR.body.details && permR.body.details.applicant_id === 1);
  assert('details.operator_id = 2', permR.body.details && permR.body.details.operator_id === 2);
  assert('details.operator_role = teacher', permR.body.details && permR.body.details.operator_role === 'teacher');

  // 文档：调度员、安全员越权取消（文档承诺同结构）
  const permDispR = await request('POST', '/api/applications/' + appId5 + '/cancel', null, { 'X-User-Id': '3' });
  assert('调度员越权 HTTP 403', permDispR.status === 403);
  assert('调度员越权 code = PERMISSION_DENIED', permDispR.body.code === 'PERMISSION_DENIED');
  const permSafeR = await request('POST', '/api/applications/' + appId5 + '/cancel', null, { 'X-User-Id': '4' });
  assert('安全员越权 HTTP 403', permSafeR.status === 403);
  assert('安全员越权 code = PERMISSION_DENIED', permSafeR.body.code === 'PERMISSION_DENIED');

  // 文档承诺：越权后状态不变
  const app5After = await request('GET', '/api/applications/' + appId5, null, { 'X-User-Id': '1' });
  assert('越权后状态仍为 PENDING_SUBMITTED', app5After.body.data.status === 'PENDING_SUBMITTED');
  assert('越权后 history 无 CANCEL', !app5After.body.data.history.some(h => h.action === 'CANCEL'));

  // ===== 文档 E2. 终态不可取消（PUBLISHED） =====
  console.log('\n--- 文档 E2：终态不可取消（PUBLISHED） ---');
  const createR6 = await request('POST', '/api/applications', {
    route_name: '终态测试线',
    original_stops: ['A', 'B'], new_stops: ['A', 'C'],
    effective_start: '2027-02-01T07:00:00.000Z', effective_end: '2027-02-01T09:00:00.000Z',
    reason: 't'
  }, { 'X-User-Id': '1' });
  const appId6 = createR6.body.data.id;
  await request('POST', '/api/applications/' + appId6 + '/dispatch-review', { approved: true }, { 'X-User-Id': '3' });
  await request('POST', '/api/applications/' + appId6 + '/safety-approve', { approved: true }, { 'X-User-Id': '4' });
  await request('POST', '/api/applications/' + appId6 + '/publish', null, { 'X-User-Id': '5' });

  const transR = await request('POST', '/api/applications/' + appId6 + '/cancel',
    { comment: '试图取消已发布' }, { 'X-User-Id': '1' });
  assert('已发布取消 HTTP 409', transR.status === 409);
  assert('终态错误五字段结构', hasErrorShape(transR.body));
  assert('code = INVALID_TRANSITION', transR.body.code === 'INVALID_TRANSITION');
  assert('details.from = PUBLISHED', transR.body.details && transR.body.details.from === 'PUBLISHED');
  assert('details.to = CANCELLED', transR.body.details && transR.body.details.to === 'CANCELLED');
  assert('details.allowed = []（文档：空数组）',
    transR.body.details && Array.isArray(transR.body.details.allowed) && transR.body.details.allowed.length === 0);
  assert('message 包含 "PUBLISHED -> CANCELLED"',
    transR.body.message && transR.body.message.indexOf('PUBLISHED') !== -1 && transR.body.message.indexOf('CANCELLED') !== -1);

  // 文档：REJECTED 终态也返回 INVALID_TRANSITION
  console.log('\n--- 文档 E2 补：终态不可取消（REJECTED） ---');
  const createR7 = await request('POST', '/api/applications', {
    route_name: '驳回测试线',
    original_stops: ['A', 'B'], new_stops: ['A', 'C'],
    effective_start: '2027-03-01T07:00:00.000Z', effective_end: '2027-03-01T09:00:00.000Z',
    reason: 't'
  }, { 'X-User-Id': '1' });
  const appId7 = createR7.body.data.id;
  await request('POST', '/api/applications/' + appId7 + '/dispatch-review', { approved: false, comment: '驳回' }, { 'X-User-Id': '3' });
  const rejR = await request('POST', '/api/applications/' + appId7 + '/cancel', null, { 'X-User-Id': '1' });
  assert('已驳回取消 HTTP 409', rejR.status === 409);
  assert('已驳回取消 code = INVALID_TRANSITION', rejR.body.code === 'INVALID_TRANSITION');
  assert('已驳回 details.from = REJECTED', rejR.body.details && rejR.body.details.from === 'REJECTED');

  // 文档：CANCELLED 终态也返回 INVALID_TRANSITION
  console.log('\n--- 文档 E2 补：终态不可取消（CANCELLED 重复取消） ---');
  const cancelAgainR = await request('POST', '/api/applications/' + appId + '/cancel', null, { 'X-User-Id': '1' });
  assert('已取消再次取消 HTTP 409', cancelAgainR.status === 409);
  assert('已取消 code = INVALID_TRANSITION', cancelAgainR.body.code === 'INVALID_TRANSITION');
  assert('已取消 details.from = CANCELLED', cancelAgainR.body.details && cancelAgainR.body.details.from === 'CANCELLED');

  // ===== 文档 E3. 申请不存在 =====
  console.log('\n--- 文档 E3：取消不存在的申请 ---');
  const nfR = await request('POST', '/api/applications/99999/cancel', null, { 'X-User-Id': '1' });
  assert('不存在申请 HTTP 404', nfR.status === 404);
  assert('不存在错误五字段结构', hasErrorShape(nfR.body));
  assert('code = NOT_FOUND', nfR.body.code === 'NOT_FOUND');
  assert('message 包含申请 id', nfR.body.message && nfR.body.message.indexOf('99999') !== -1);

  // ===== 文档：三态均可取消（DISPATCH_REVIEWED、SAFETY_APPROVED） =====
  console.log('\n--- 文档：可取消状态覆盖 DISPATCH_REVIEWED ---');
  const createR8 = await request('POST', '/api/applications', {
    route_name: '三态测试线1',
    original_stops: ['A', 'B'], new_stops: ['A', 'C'],
    effective_start: '2027-04-01T07:00:00.000Z', effective_end: '2027-04-01T09:00:00.000Z',
    reason: 't'
  }, { 'X-User-Id': '1' });
  const appId8 = createR8.body.data.id;
  await request('POST', '/api/applications/' + appId8 + '/dispatch-review', { approved: true }, { 'X-User-Id': '3' });
  const r8 = await request('POST', '/api/applications/' + appId8 + '/cancel', { comment: '待安全审批阶段取消' }, { 'X-User-Id': '1' });
  assert('DISPATCH_REVIEWED 取消 HTTP 200', r8.status === 200);
  assert('DISPATCH_REVIEWED 取消后状态 CANCELLED', r8.body.data.status === 'CANCELLED');
  const h8 = r8.body.data.history.find(h => h.action === 'CANCEL');
  assert('CANCEL.from_status = DISPATCH_REVIEWED', h8 && h8.from_status === 'DISPATCH_REVIEWED');

  console.log('\n--- 文档：可取消状态覆盖 SAFETY_APPROVED ---');
  const createR9 = await request('POST', '/api/applications', {
    route_name: '三态测试线2',
    original_stops: ['A', 'B'], new_stops: ['A', 'C'],
    effective_start: '2027-05-01T07:00:00.000Z', effective_end: '2027-05-01T09:00:00.000Z',
    reason: 't'
  }, { 'X-User-Id': '1' });
  const appId9 = createR9.body.data.id;
  await request('POST', '/api/applications/' + appId9 + '/dispatch-review', { approved: true }, { 'X-User-Id': '3' });
  await request('POST', '/api/applications/' + appId9 + '/safety-approve', { approved: true }, { 'X-User-Id': '4' });
  const r9 = await request('POST', '/api/applications/' + appId9 + '/cancel', { comment: '待发布阶段取消' }, { 'X-User-Id': '1' });
  assert('SAFETY_APPROVED 取消 HTTP 200', r9.status === 200);
  assert('SAFETY_APPROVED 取消后状态 CANCELLED', r9.body.data.status === 'CANCELLED');
  const h9 = r9.body.data.history.find(h => h.action === 'CANCEL');
  assert('CANCEL.from_status = SAFETY_APPROVED', h9 && h9.from_status === 'SAFETY_APPROVED');

  // ===== 文档：列表、JSON/CSV 导出含 CANCELLED / 取消备注 =====
  console.log('\n--- 文档：列表/导出可见 CANCELLED 状态与取消备注 ---');
  const listR = await request('GET', '/api/applications?status=CANCELLED&page_size=100', null, { 'X-User-Id': '1' });
  assert('列表 HTTP 200', listR.status === 200);
  const firstItem = listR.body.data.items && listR.body.data.items[0];
  assert('列表项含 status=CANCELLED', firstItem && firstItem.status === 'CANCELLED');
  assert('列表项含 status_label=已取消', firstItem && firstItem.status_label === '已取消');
  assert('列表项含 cancel_remark 字段且非空', firstItem && 'cancel_remark' in firstItem && !!firstItem.cancel_remark);

  const jsonExpR = await request('GET', '/api/applications/export?format=json', null, { 'X-User-Id': '1' });
  assert('JSON 导出 HTTP 200', jsonExpR.status === 200);
  const jsonCancelled = jsonExpR.body.items.filter(it => it.status === 'CANCELLED');
  assert('JSON 导出包含 CANCELLED 条目', jsonCancelled.length > 0);
  assert('JSON 导出 CANCELLED 条目含 cancel_remark', jsonCancelled[0] && !!jsonCancelled[0].cancel_remark);

  const csvExpR = await request('GET', '/api/applications/export?format=csv', null, { 'X-User-Id': '1' });
  assert('CSV 导出 HTTP 200', csvExpR.status === 200);
  assert('CSV 表头含「取消备注」列', csvExpR.raw.indexOf('取消备注') !== -1);
  assert('CSV 数据含 CANCELLED', csvExpR.raw.indexOf('CANCELLED') !== -1);
  assert('CSV 数据含取消备注内容「计划有变，暂不需要改线」',
    csvExpR.raw.indexOf('计划有变，暂不需要改线') !== -1);

  // ===== 文档：错误结构与现有接口一致 =====
  console.log('\n--- 文档：错误响应结构与现有接口一致（五字段） ---');
  const allErrors = [permR, transR, rejR, nfR];
  let allConsistent = true;
  for (const er of allErrors) {
    if (!er.body || er.body.success !== false || !('code' in er.body) || !('message' in er.body) || !('details' in er.body) || !('timestamp' in er.body)) {
      allConsistent = false;
    }
  }
  assert('全部失败响应 success=false 且包含 code/message/details/timestamp', allConsistent);

  const okR = [selfCancelR, adminCancelR, r8, r9];
  let allOkConsistent = true;
  for (const ok of okR) {
    if (!ok.body || ok.body.success !== true || ok.body.code !== 'OK' || !('message' in ok.body) || !('data' in ok.body) || !('timestamp' in ok.body)) {
      allOkConsistent = false;
    }
  }
  assert('全部成功响应 success=true、code=OK 且包含 message/data/timestamp', allOkConsistent);

  console.log('\n======== 汇总 ========');
  console.log('通过: ' + pass + ' / ' + (pass + fail));
  console.log('失败: ' + fail + ' / ' + (pass + fail));
  if (fail > 0) {
    console.log('\n❌ 存在失败，README 示例与真实接口不一致！');
  } else {
    console.log('\n✅ 全部通过：README 所有取消接口示例、响应结构、默认值均与真实接口一致。');
  }

  await stopServer();
  process.exit(fail > 0 ? 1 : 0);
})().catch(async (e) => {
  console.error('\n测试执行出错:', e);
  try { await stopServer(); } catch (_) { }
  process.exit(1);
});
