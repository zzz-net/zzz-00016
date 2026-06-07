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

function createAppBody(suffix) {
  return {
    route_name: '测试线' + suffix,
    original_stops: ['A', 'B', 'C'],
    new_stops: ['A', 'D', 'C'],
    effective_start: '2026-09-01T07:00:00.000Z',
    effective_end: '2026-09-01T09:00:00.000Z',
    vehicle_id: 'BUS-TEST' + suffix,
    reason: '测试原因' + suffix
  };
}

async function createApplication(userId, suffix) {
  const r = await request('POST', '/api/applications', createAppBody(suffix), { 'X-User-Id': String(userId) });
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

(async () => {
  console.log('\n======== 校车改线 —— 取消申请链路全场景测试 ========\n');

  section('准备：清空数据库并启动服务');

  deleteDbIfExists();
  spawnSync('node', ['src/scripts/init-db.js'], { cwd: __dirname, stdio: 'inherit' });
  await startServer();
  await waitForHealth();
  console.log('  服务就绪');

  // =====================================================
  section('场景 1：申请人本人取消（待调度复核 PENDING_SUBMITTED）');

  const app1 = await createApplication(1, '-A');
  const r1 = await request('POST', '/api/applications/' + app1 + '/cancel',
    { comment: '计划有变，不需要改线了' },
    { 'X-User-Id': '1' });
  assert('取消接口返回 200', r1.status === 200, 'status=' + r1.status);
  assert('返回 success=true', r1.body && r1.body.success === true);
  assert('状态变为 CANCELLED', r1.body && r1.body.data && r1.body.data.status === 'CANCELLED');
  assert('状态文案为 已取消', r1.body && r1.body.data && r1.body.data.status_label === '已取消');
  assert('cancel_remark 记录备注', r1.body && r1.body.data && r1.body.data.cancel_remark === '计划有变，不需要改线了');
  const h1 = (r1.body && r1.body.data && r1.body.data.history) || [];
  const cancelEntry1 = h1.find(h => h.action === 'CANCEL');
  assert('history 含 CANCEL 记录', !!cancelEntry1, cancelEntry1 ? ('action=' + cancelEntry1.action + ', operator_id=' + (cancelEntry1.operator && cancelEntry1.operator.id)) : '无');
  assert('CANCEL 操作人是申请人本人', cancelEntry1 && cancelEntry1.operator && cancelEntry1.operator.id === 1);
  assert('CANCEL from_status = PENDING_SUBMITTED', cancelEntry1 && cancelEntry1.from_status === 'PENDING_SUBMITTED');
  assert('CANCEL to_status = CANCELLED', cancelEntry1 && cancelEntry1.to_status === 'CANCELLED');
  assert('CANCEL comment 正确', cancelEntry1 && cancelEntry1.comment === '计划有变，不需要改线了');

  // =====================================================
  section('场景 2：申请人本人取消（待安全审批 DISPATCH_REVIEWED）');

  const app2 = await createApplication(1, '-B');
  await advanceTo(app2, 'DISPATCH_REVIEWED');
  const r2 = await request('POST', '/api/applications/' + app2 + '/cancel',
    { comment: '路线重新规划后取消' },
    { 'X-User-Id': '1' });
  assert('取消接口返回 200', r2.status === 200);
  assert('状态变为 CANCELLED', r2.body && r2.body.data && r2.body.data.status === 'CANCELLED');
  const h2 = r2.body.data.history;
  const cancelEntry2 = h2.find(h => h.action === 'CANCEL');
  assert('CANCEL from_status = DISPATCH_REVIEWED', cancelEntry2 && cancelEntry2.from_status === 'DISPATCH_REVIEWED');

  // =====================================================
  section('场景 3：申请人本人取消（待发布 SAFETY_APPROVED）');

  const app3 = await createApplication(1, '-C');
  await advanceTo(app3, 'SAFETY_APPROVED');
  const r3 = await request('POST', '/api/applications/' + app3 + '/cancel',
    { comment: '发布前取消' },
    { 'X-User-Id': '1' });
  assert('取消接口返回 200', r3.status === 200);
  assert('状态变为 CANCELLED', r3.body && r3.body.data && r3.body.data.status === 'CANCELLED');
  const h3 = r3.body.data.history;
  const cancelEntry3 = h3.find(h => h.action === 'CANCEL');
  assert('CANCEL from_status = SAFETY_APPROVED', cancelEntry3 && cancelEntry3.from_status === 'SAFETY_APPROVED');

  // =====================================================
  section('场景 4：admin 代取消');

  const app4 = await createApplication(2, '-D');
  const r4 = await request('POST', '/api/applications/' + app4 + '/cancel',
    { comment: '管理员核实后代取消' },
    { 'X-User-Id': '5' });
  assert('admin 取消返回 200', r4.status === 200);
  assert('状态变为 CANCELLED', r4.body && r4.body.data && r4.body.data.status === 'CANCELLED');
  assert('cancel_remark 记录备注', r4.body && r4.body.data && r4.body.data.cancel_remark === '管理员核实后代取消');
  const h4 = r4.body.data.history;
  const cancelEntry4 = h4.find(h => h.action === 'CANCEL');
  assert('CANCEL 操作人是 admin (id=5)', cancelEntry4 && cancelEntry4.operator && cancelEntry4.operator.id === 5);
  assert('CANCEL 操作人角色是 admin', cancelEntry4 && cancelEntry4.operator && cancelEntry4.operator.role === 'admin');

  // =====================================================
  section('场景 5：越权取消 —— 其他老师取消别人的申请');

  const app5 = await createApplication(1, '-E');
  const r5 = await request('POST', '/api/applications/' + app5 + '/cancel',
    { comment: '恶意取消' },
    { 'X-User-Id': '2' });
  assert('越权取消返回 403', r5.status === 403);
  assert('错误码 PERMISSION_DENIED', r5.body && r5.body.code === 'PERMISSION_DENIED');
  assert('错误结构包含 details', r5.body && r5.body.details && r5.body.details.applicant_id === 1 && r5.body.details.operator_id === 2);
  const app5After = await request('GET', '/api/applications/' + app5, null, { 'X-User-Id': '1' });
  assert('越权取消后状态不变', app5After.body && app5After.body.data && app5After.body.data.status === 'PENDING_SUBMITTED');
  const hasCancelInHistory5 = app5After.body.data.history.some(h => h.action === 'CANCEL');
  assert('越权取消后 history 无 CANCEL 记录', !hasCancelInHistory5);

  // =====================================================
  section('场景 6：越权取消 —— 调度/安全员尝试取消（非申请人非 admin）');

  const app6 = await createApplication(1, '-F');
  const r6a = await request('POST', '/api/applications/' + app6 + '/cancel', null, { 'X-User-Id': '3' });
  assert('调度员取消别人申请返回 403', r6a.status === 403);
  assert('错误码 PERMISSION_DENIED', r6a.body && r6a.body.code === 'PERMISSION_DENIED');
  const r6b = await request('POST', '/api/applications/' + app6 + '/cancel', null, { 'X-User-Id': '4' });
  assert('安全员取消别人申请返回 403', r6b.status === 403);
  assert('错误码 PERMISSION_DENIED', r6b.body && r6b.body.code === 'PERMISSION_DENIED');

  // =====================================================
  section('场景 7：终态不可取消 —— 已发布 PUBLISHED');

  const app7 = await createApplication(1, '-G');
  await advanceTo(app7, 'PUBLISHED');
  const r7 = await request('POST', '/api/applications/' + app7 + '/cancel',
    { comment: '试图取消已发布' },
    { 'X-User-Id': '1' });
  assert('已发布取消返回 409', r7.status === 409);
  assert('错误码 INVALID_TRANSITION', r7.body && r7.body.code === 'INVALID_TRANSITION');
  assert('details 包含 from/to/allowed',
    r7.body && r7.body.details && r7.body.details.from === 'PUBLISHED' && r7.body.details.to === 'CANCELLED' && Array.isArray(r7.body.details.allowed));
  const app7After = await request('GET', '/api/applications/' + app7, null, { 'X-User-Id': '1' });
  assert('已发布状态不变', app7After.body && app7After.body.data && app7After.body.data.status === 'PUBLISHED');

  // =====================================================
  section('场景 8：终态不可取消 —— 已驳回 REJECTED');

  const app8 = await createApplication(1, '-H');
  await advanceTo(app8, 'REJECTED');
  const r8 = await request('POST', '/api/applications/' + app8 + '/cancel', null, { 'X-User-Id': '1' });
  assert('已驳回取消返回 409', r8.status === 409);
  assert('错误码 INVALID_TRANSITION', r8.body && r8.body.code === 'INVALID_TRANSITION');
  assert('details.from = REJECTED', r8.body && r8.body.details && r8.body.details.from === 'REJECTED');

  // =====================================================
  section('场景 9：终态不可取消 —— 已取消 CANCELLED（重复取消校验）');

  const r9 = await request('POST', '/api/applications/' + app1 + '/cancel',
    { comment: '重复取消' },
    { 'X-User-Id': '1' });
  assert('已取消再次取消返回 409', r9.status === 409);
  assert('错误码 INVALID_TRANSITION', r9.body && r9.body.code === 'INVALID_TRANSITION');
  assert('details.from = CANCELLED', r9.body && r9.body.details && r9.body.details.from === 'CANCELLED');

  // =====================================================
  section('场景 10：取消时未传 comment 使用默认备注');

  const app10 = await createApplication(1, '-I');
  const r10a = await request('POST', '/api/applications/' + app10 + '/cancel', null, { 'X-User-Id': '1' });
  assert('本人取消默认备注 = 申请人取消', r10a.body && r10a.body.data && r10a.body.data.cancel_remark === '申请人取消');

  const app10b = await createApplication(2, '-J');
  const r10b = await request('POST', '/api/applications/' + app10b + '/cancel', null, { 'X-User-Id': '5' });
  assert('admin 代取消默认备注 = 管理员代取消', r10b.body && r10b.body.data && r10b.body.data.cancel_remark === '管理员代取消');

  // =====================================================
  section('场景 11：列表查询能看到 CANCELLED 状态、状态文案、取消备注');

  const listR = await request('GET', '/api/applications?status=CANCELLED&page_size=100', null, { 'X-User-Id': '1' });
  assert('列表返回 200', listR.status === 200);
  const cancelledItems = listR.body.data.items;
  assert('列表至少含 5 条已取消条目', cancelledItems && cancelledItems.length >= 5, '实际=' + (cancelledItems ? cancelledItems.length : 0));
  const firstCancelled = cancelledItems && cancelledItems[0];
  if (firstCancelled) {
    assert('列表项含 status=CANCELLED', firstCancelled.status === 'CANCELLED');
    assert('列表项含 status_label=已取消', firstCancelled.status_label === '已取消');
    assert('列表项含 cancel_remark 字段', 'cancel_remark' in firstCancelled);
  }

  // =====================================================
  section('场景 12：JSON 导出包含 CANCELLED 状态、文案、取消备注');

  const jsonR = await request('GET', '/api/applications/export?format=json', null, { 'X-User-Id': '1' });
  assert('JSON 导出返回 200', jsonR.status === 200);
  const jsonCancelled = jsonR.body.items.filter(it => it.status === 'CANCELLED');
  assert('JSON 导出含 CANCELLED 条目', jsonCancelled.length >= 5);
  const jc = jsonCancelled[0];
  if (jc) {
    assert('JSON 导出项含 status_label=已取消', jc.status_label === '已取消');
    assert('JSON 导出项含 cancel_remark 字段且有值', 'cancel_remark' in jc && !!jc.cancel_remark);
  }

  // =====================================================
  section('场景 13：CSV 导出包含 CANCELLED 状态、状态文案、取消备注');

  const csvR = await request('GET', '/api/applications/export?format=csv', null, { 'X-User-Id': '1' });
  assert('CSV 导出返回 200', csvR.status === 200);
  assert('CSV 表头包含 取消备注 列', csvR.raw.indexOf('取消备注') !== -1);
  assert('CSV 数据包含 CANCELLED', csvR.raw.indexOf('CANCELLED') !== -1);
  assert('CSV 数据包含 已取消', csvR.raw.indexOf('已取消') !== -1);
  assert('CSV 数据包含取消备注内容', csvR.raw.indexOf('计划有变，不需要改线了') !== -1);

  // =====================================================
  section('场景 14：重启服务后数据仍然存在（持久化验证）');

  console.log('  停止服务...');
  await stopServer();
  await new Promise(r => setTimeout(r, 800));
  console.log('  重新启动服务...');
  await startServer();
  await waitForHealth();
  console.log('  服务已重启');

  const app1AfterRestart = await request('GET', '/api/applications/' + app1, null, { 'X-User-Id': '1' });
  assert('重启后详情状态仍为 CANCELLED', app1AfterRestart.body && app1AfterRestart.body.data && app1AfterRestart.body.data.status === 'CANCELLED');
  assert('重启后 cancel_remark 仍存在', app1AfterRestart.body && app1AfterRestart.body.data && app1AfterRestart.body.data.cancel_remark === '计划有变，不需要改线了');
  const hRestart = (app1AfterRestart.body && app1AfterRestart.body.data && app1AfterRestart.body.data.history) || [];
  const cancelRestart = hRestart.find(h => h.action === 'CANCEL');
  assert('重启后 history 仍含 CANCEL 记录', !!cancelRestart);

  const listAfterRestart = await request('GET', '/api/applications?status=CANCELLED&page_size=100', null, { 'X-User-Id': '1' });
  assert('重启后列表仍有 CANCELLED 条目', listAfterRestart.body && listAfterRestart.body.data && listAfterRestart.body.data.items.length >= 5);

  const jsonAfterRestart = await request('GET', '/api/applications/export?format=json', null, { 'X-User-Id': '1' });
  assert('重启后 JSON 导出仍有 CANCELLED', jsonAfterRestart.body && jsonAfterRestart.body.items.filter(it => it.status === 'CANCELLED').length >= 5);

  const csvAfterRestart = await request('GET', '/api/applications/export?format=csv', null, { 'X-User-Id': '1' });
  assert('重启后 CSV 导出仍有 CANCELLED 和取消备注',
    csvAfterRestart.raw.indexOf('CANCELLED') !== -1 && csvAfterRestart.raw.indexOf('计划有变，不需要改线了') !== -1);

  // =====================================================
  section('场景 15：不存在的申请取消返回 NOT_FOUND');

  const r15 = await request('POST', '/api/applications/99999/cancel', null, { 'X-User-Id': '1' });
  assert('不存在申请取消返回 404', r15.status === 404);
  assert('错误码 NOT_FOUND', r15.body && r15.body.code === 'NOT_FOUND');

  // =====================================================
  section('场景 16：approval_logs 记录取消操作');

  // 上面各场景已经通过 history 验证了 approval_logs 写入
  assert('app1 取消在 history 有 CANCEL 记录（approval_logs）', !!cancelEntry1);
  assert('app2 取消在 history 有 CANCEL 记录（approval_logs）', !!cancelEntry2);
  assert('app3 取消在 history 有 CANCEL 记录（approval_logs）', !!cancelEntry3);
  assert('app4 取消在 history 有 CANCEL 记录（approval_logs）', !!cancelEntry4);

  // =====================================================
  section('场景 17：错误响应结构与现有接口一致');

  assert('越权错误结构一致（success/code/message/details/timestamp）',
    r5.body &&
    'success' in r5.body &&
    'code' in r5.body &&
    'message' in r5.body &&
    'details' in r5.body &&
    'timestamp' in r5.body &&
    r5.body.success === false);

  assert('状态流转错误结构一致',
    r7.body &&
    r7.body.success === false &&
    r7.body.code &&
    r7.body.message &&
    r7.body.details &&
    r7.body.timestamp);

  assert('成功响应结构一致（success/code/message/data/timestamp）',
    r1.body &&
    r1.body.success === true &&
    r1.body.code === 'OK' &&
    r1.body.message &&
    r1.body.data &&
    r1.body.timestamp);

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
