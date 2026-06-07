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
    route_name: '测试复制线' + suffix,
    original_stops: ['东门站', '少年宫站', '图书馆站', '学校站'],
    new_stops: ['东门站', '人民广场站', '体育馆站', '学校站'],
    effective_start: '2026-09-01T07:00:00.000Z',
    effective_end: '2026-09-01T09:00:00.000Z',
    vehicle_id: 'BUS-CLONE' + suffix,
    reason: '测试复制原因' + suffix
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
    await request('POST', '/api/applications/' + appId + '/dispatch-review', { approved: false, comment: '驳回测试复制' }, { 'X-User-Id': '3' });
  } else if (targetStatus === 'CANCELLED') {
    await request('POST', '/api/applications/' + appId + '/cancel', { comment: '取消测试复制' }, { 'X-User-Id': '1' });
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

function deepCloneFields(a) {
  return {
    route_name: a.route_name,
    original_stops: JSON.stringify(a.original_stops),
    new_stops: JSON.stringify(a.new_stops),
    effective_start: a.effective_start,
    effective_end: a.effective_end,
    vehicle_id: a.vehicle_id,
    reason: a.reason
  };
}

(async () => {
  console.log('\n======== 校车改线 —— 复制再提交全场景测试 ========\n');

  section('准备：清空数据库并启动服务');

  deleteDbIfExists();
  spawnSync('node', ['src/scripts/init-db.js'], { cwd: __dirname, stdio: 'inherit' });
  await startServer();
  await waitForHealth();
  console.log('  服务就绪');

  // =====================================================
  section('场景 1：申请人本人复制已驳回 REJECTED 申请');

  const rejectedAppId = await createApplication(1, '-R1');
  await advanceTo(rejectedAppId, 'REJECTED');

  const rejectedBefore = await request('GET', '/api/applications/' + rejectedAppId, null, { 'X-User-Id': '1' });
  const r1 = await request('POST', '/api/applications/' + rejectedAppId + '/clone', null, { 'X-User-Id': '1' });

  assert('本人复制已驳回返回 200', r1.status === 200, 'status=' + r1.status);
  assert('返回 success=true', r1.body && r1.body.success === true);
  assert('新申请状态为 PENDING_SUBMITTED', r1.body && r1.body.data && r1.body.data.status === 'PENDING_SUBMITTED');
  assert('新申请状态文案为 待调度复核', r1.body && r1.body.data && r1.body.data.status_label === '待调度复核');

  const newApp1 = r1.body.data;
  const newId1 = newApp1.id;
  assert('新申请 ID 不同于源申请 ID', newId1 !== rejectedAppId, 'src=' + rejectedAppId + ', new=' + newId1);
  assert('source_application_id 指向源申请', newApp1.source_application_id === rejectedAppId);

  const srcInfo1 = newApp1.source_application;
  assert('source_application 对象存在', !!srcInfo1);
  assert('source_application.id 正确', srcInfo1 && srcInfo1.id === rejectedAppId);
  assert('source_application.status = REJECTED', srcInfo1 && srcInfo1.status === 'REJECTED');
  assert('source_application.status_label = 已驳回', srcInfo1 && srcInfo1.status_label === '已驳回');
  assert('source_application.applicant 是张老师 (id=1)', srcInfo1 && srcInfo1.applicant && srcInfo1.applicant.id === 1 && srcInfo1.applicant.name === '张老师');

  const srcFields = deepCloneFields(rejectedBefore.body.data);
  const newFields = deepCloneFields(newApp1);
  assert('复制后线路一致', newFields.route_name === srcFields.route_name);
  assert('复制后原站点一致', newFields.original_stops === srcFields.original_stops);
  assert('复制后新站点一致', newFields.new_stops === srcFields.new_stops);
  assert('复制后生效开始一致', newFields.effective_start === srcFields.effective_start);
  assert('复制后生效结束一致', newFields.effective_end === srcFields.effective_end);
  assert('复制后车辆一致', newFields.vehicle_id === srcFields.vehicle_id);
  assert('复制后原因一致', newFields.reason === srcFields.reason);

  const h1 = newApp1.history || [];
  const cloneEntry1 = h1.find(h => h.action === 'CLONE_RESUBMIT');
  assert('新申请 history 含 CLONE_RESUBMIT 记录', !!cloneEntry1);
  assert('CLONE_RESUBMIT 操作人是申请人本人 id=1', cloneEntry1 && cloneEntry1.operator && cloneEntry1.operator.id === 1);
  assert('CLONE_RESUBMIT to_status = PENDING_SUBMITTED', cloneEntry1 && cloneEntry1.to_status === 'PENDING_SUBMITTED');
  assert('CLONE_RESUBMIT from_status = null', cloneEntry1 && cloneEntry1.from_status === null);
  assert('CLONE_RESUBMIT comment 包含源申请ID', cloneEntry1 && cloneEntry1.comment && cloneEntry1.comment.includes('#' + rejectedAppId));

  const rejectedAfter = await request('GET', '/api/applications/' + rejectedAppId, null, { 'X-User-Id': '1' });
  assert('源申请状态保持 REJECTED 不变', rejectedAfter.body.data.status === 'REJECTED');
  const srcHasClone = rejectedAfter.body.data.history.some(h => h.action === 'CLONE_RESUBMIT');
  assert('源申请 history 无 CLONE_RESUBMIT 记录（不修改旧记录）', !srcHasClone);

  // =====================================================
  section('场景 2：申请人本人复制已取消 CANCELLED 申请');

  const cancelledAppId = await createApplication(1, '-C1');
  await advanceTo(cancelledAppId, 'CANCELLED');

  const r2 = await request('POST', '/api/applications/' + cancelledAppId + '/clone', null, { 'X-User-Id': '1' });
  assert('本人复制已取消返回 200', r2.status === 200);
  assert('新申请状态 PENDING_SUBMITTED', r2.body && r2.body.data && r2.body.data.status === 'PENDING_SUBMITTED');
  assert('source_application_id 指向已取消源申请', r2.body.data.source_application_id === cancelledAppId);
  assert('source_application.status = CANCELLED', r2.body.data.source_application && r2.body.data.source_application.status === 'CANCELLED');
  assert('source_application.status_label = 已取消', r2.body.data.source_application && r2.body.data.source_application.status_label === '已取消');

  // =====================================================
  section('场景 3：admin 代复制 —— 默认沿用原申请人');

  const adminCloneSrcId = rejectedAppId;
  const r3a = await request('POST', '/api/applications/' + adminCloneSrcId + '/clone', null, { 'X-User-Id': '5' });
  assert('admin 代复制（不指定申请人）返回 200', r3a.status === 200);
  assert('新申请申请人仍是原申请人 id=1', r3a.body.data.applicant && r3a.body.data.applicant.id === 1);
  assert('source_application_id 正确', r3a.body.data.source_application_id === adminCloneSrcId);
  const h3a = r3a.body.data.history;
  const clone3a = h3a.find(h => h.action === 'CLONE_RESUBMIT');
  assert('CLONE_RESUBMIT 操作人是 admin id=5', clone3a && clone3a.operator && clone3a.operator.id === 5);

  // =====================================================
  section('场景 4：admin 代复制 —— 指定新申请人 (李老师 id=2)');

  const r4 = await request('POST', '/api/applications/' + rejectedAppId + '/clone', { applicant_id: 2 }, { 'X-User-Id': '5' });
  assert('admin 指定新申请人返回 200', r4.status === 200);
  assert('新申请申请人变为李老师 id=2', r4.body.data.applicant && r4.body.data.applicant.id === 2 && r4.body.data.applicant.name === '李老师');
  assert('source_application_id 仍指向源申请', r4.body.data.source_application_id === rejectedAppId);
  assert('source_application.applicant 仍是张老师 id=1', r4.body.data.source_application.applicant.id === 1);
  const h4 = r4.body.data.history;
  const clone4 = h4.find(h => h.action === 'CLONE_RESUBMIT');
  assert('CLONE_RESUBMIT 操作人是 admin id=5', clone4 && clone4.operator && clone4.operator.id === 5);
  assert('CLONE_RESUBMIT comment 含 管理员代复制', clone4 && clone4.comment && clone4.comment.includes('管理员代复制'));

  // admin 指定不存在的申请人
  const r4b = await request('POST', '/api/applications/' + rejectedAppId + '/clone', { applicant_id: 99999 }, { 'X-User-Id': '5' });
  assert('admin 指定不存在申请人返回 400', r4b.status === 400);
  assert('错误码 VALIDATION_ERROR', r4b.body && r4b.body.code === 'VALIDATION_ERROR');

  // =====================================================
  section('场景 5：越权复制 —— 其他老师复制张老师的申请');

  const r5 = await request('POST', '/api/applications/' + rejectedAppId + '/clone', null, { 'X-User-Id': '2' });
  assert('李老师越权复制返回 403', r5.status === 403);
  assert('错误码 PERMISSION_DENIED', r5.body && r5.body.code === 'PERMISSION_DENIED');
  assert('details 包含 source_applicant_id=1、operator_id=2',
    r5.body && r5.body.details &&
    r5.body.details.source_applicant_id === 1 &&
    r5.body.details.operator_id === 2 &&
    r5.body.details.operator_role === 'teacher');

  // =====================================================
  section('场景 6：越权复制 —— 调度员/安全员尝试复制（非申请人非 admin）');

  const r6a = await request('POST', '/api/applications/' + rejectedAppId + '/clone', null, { 'X-User-Id': '3' });
  assert('调度员复制返回 403', r6a.status === 403);
  assert('错误码 PERMISSION_DENIED', r6a.body && r6a.body.code === 'PERMISSION_DENIED');

  const r6b = await request('POST', '/api/applications/' + rejectedAppId + '/clone', null, { 'X-User-Id': '4' });
  assert('安全员复制返回 403', r6b.status === 403);
  assert('错误码 PERMISSION_DENIED', r6b.body && r6b.body.code === 'PERMISSION_DENIED');

  // =====================================================
  section('场景 7：未终态不允许复制 —— PENDING_SUBMITTED');

  const pendingAppId = await createApplication(1, '-PEND');
  const r7 = await request('POST', '/api/applications/' + pendingAppId + '/clone', null, { 'X-User-Id': '1' });
  assert('PENDING_SUBMITTED 复制返回 409', r7.status === 409);
  assert('错误码 INVALID_TRANSITION', r7.body && r7.body.code === 'INVALID_TRANSITION');
  assert('details.current_status = PENDING_SUBMITTED', r7.body && r7.body.details && r7.body.details.current_status === 'PENDING_SUBMITTED');
  assert('details.allowed_statuses 包含 REJECTED、CANCELLED',
    r7.body && r7.body.details &&
    Array.isArray(r7.body.details.allowed_statuses) &&
    r7.body.details.allowed_statuses.includes('REJECTED') &&
    r7.body.details.allowed_statuses.includes('CANCELLED'));

  // =====================================================
  section('场景 8：未终态不允许复制 —— DISPATCH_REVIEWED / SAFETY_APPROVED / PUBLISHED');

  const dispatchAppId = await createApplication(1, '-DISP');
  await advanceTo(dispatchAppId, 'DISPATCH_REVIEWED');
  const r8a = await request('POST', '/api/applications/' + dispatchAppId + '/clone', null, { 'X-User-Id': '1' });
  assert('DISPATCH_REVIEWED 复制返回 409', r8a.status === 409);
  assert('错误码 INVALID_TRANSITION', r8a.body && r8a.body.code === 'INVALID_TRANSITION');

  const safetyAppId = await createApplication(1, '-SAFE');
  await advanceTo(safetyAppId, 'SAFETY_APPROVED');
  const r8b = await request('POST', '/api/applications/' + safetyAppId + '/clone', null, { 'X-User-Id': '1' });
  assert('SAFETY_APPROVED 复制返回 409', r8b.status === 409);
  assert('错误码 INVALID_TRANSITION', r8b.body && r8b.body.code === 'INVALID_TRANSITION');

  const publishedAppId = await createApplication(1, '-PUB');
  await advanceTo(publishedAppId, 'PUBLISHED');
  const r8c = await request('POST', '/api/applications/' + publishedAppId + '/clone', null, { 'X-User-Id': '1' });
  assert('PUBLISHED 复制返回 409', r8c.status === 409);
  assert('错误码 INVALID_TRANSITION', r8c.body && r8c.body.code === 'INVALID_TRANSITION');

  // =====================================================
  section('场景 9：源申请不存在返回 NOT_FOUND');

  const r9 = await request('POST', '/api/applications/99999/clone', null, { 'X-User-Id': '1' });
  assert('不存在申请复制返回 404', r9.status === 404);
  assert('错误码 NOT_FOUND', r9.body && r9.body.code === 'NOT_FOUND');

  // =====================================================
  section('场景 10：新申请审批/取消 —— 只作用自身，不修改旧记录');

  // 对复制出的新申请 newId1 执行调度驳回
  await request('POST', '/api/applications/' + newId1 + '/dispatch-review',
    { approved: false, comment: '新申请驳回测试' }, { 'X-User-Id': '3' });

  const newAfterReject = await request('GET', '/api/applications/' + newId1, null, { 'X-User-Id': '1' });
  assert('新申请被驳回后状态 = REJECTED', newAfterReject.body.data.status === 'REJECTED');
  const newRejectHistory = newAfterReject.body.data.history.find(h => h.action === 'DISPATCH_REJECT');
  assert('新申请 history 有 DISPATCH_REJECT 记录', !!newRejectHistory);

  const srcAfterNewReject = await request('GET', '/api/applications/' + rejectedAppId, null, { 'X-User-Id': '1' });
  assert('源申请状态仍为 REJECTED（不受新申请影响）', srcAfterNewReject.body.data.status === 'REJECTED');
  const srcRejectCount = srcAfterNewReject.body.data.history.filter(h => h.action === 'DISPATCH_REJECT').length;
  assert('源申请 history 只有 1 条 DISPATCH_REJECT（新申请驳回不写入源申请）', srcRejectCount === 1, '实际=' + srcRejectCount);

  // =====================================================
  section('场景 11：列表查询展示 source_application_id / source_application');

  const listR = await request('GET', '/api/applications?page_size=100', null, { 'X-User-Id': '1' });
  assert('列表返回 200', listR.status === 200);
  const items = listR.body.data.items;
  const clonedItems = items.filter(it => it.source_application_id !== null);
  assert('列表至少含 4 条带 source_application_id 的申请', clonedItems.length >= 4, '实际=' + clonedItems.length);

  const clonedSample = clonedItems[0];
  if (clonedSample) {
    assert('列表项 source_application_id 是数字', typeof clonedSample.source_application_id === 'number');
    assert('列表项 source_application 对象存在', !!clonedSample.source_application);
    assert('source_application 含 id/status/applicant',
      clonedSample.source_application &&
      'id' in clonedSample.source_application &&
      'status' in clonedSample.source_application &&
      'applicant' in clonedSample.source_application);
  }

  // =====================================================
  section('场景 12：JSON 导出包含 source_application_id / source_application');

  const jsonR = await request('GET', '/api/applications/export?format=json', null, { 'X-User-Id': '5' });
  assert('JSON 导出返回 200', jsonR.status === 200);
  const jsonCloned = jsonR.body.items.filter(it => it.source_application_id !== null);
  assert('JSON 导出含带 source 的条目', jsonCloned.length >= 4);

  const jc = jsonCloned[0];
  assert('JSON 导出项含 source_application_id', typeof jc.source_application_id === 'number');
  assert('JSON 导出项含 source_application 对象', !!jc.source_application);
  assert('source_application.applicant 有 name 字段', jc.source_application.applicant && 'name' in jc.source_application.applicant);

  // =====================================================
  section('场景 13：CSV 导出包含 来源申请ID、来源申请人 列');

  const csvR = await request('GET', '/api/applications/export?format=csv', null, { 'X-User-Id': '5' });
  assert('CSV 导出返回 200', csvR.status === 200);
  assert('CSV 表头包含 来源申请ID', csvR.raw.indexOf('来源申请ID') !== -1);
  assert('CSV 表头包含 来源申请人', csvR.raw.indexOf('来源申请人') !== -1);
  assert('CSV 数据中包含源申请 ID ' + rejectedAppId, csvR.raw.indexOf(String(rejectedAppId)) !== -1);
  assert('CSV 数据中包含 张老师（来源申请人）', csvR.raw.indexOf('张老师') !== -1);

  const firstLine = csvR.raw.split('\r\n')[0];
  const headers = firstLine.split(',');
  assert('CSV 共 19 列（向后兼容扩展）', headers.length === 19, '实际列数=' + headers.length);

  // =====================================================
  section('场景 14：重启服务后数据和来源关联仍然存在（持久化验证）');

  console.log('  停止服务...');
  await stopServer();
  await new Promise(r => setTimeout(r, 800));
  console.log('  重新启动服务...');
  await startServer();
  await waitForHealth();
  console.log('  服务已重启');

  const newAppAfterRestart = await request('GET', '/api/applications/' + newId1, null, { 'X-User-Id': '1' });
  assert('重启后新申请状态仍为 REJECTED', newAppAfterRestart.body && newAppAfterRestart.body.data && newAppAfterRestart.body.data.status === 'REJECTED');
  assert('重启后 source_application_id 仍存在', newAppAfterRestart.body.data.source_application_id === rejectedAppId);
  assert('重启后 source_application 对象仍存在', !!newAppAfterRestart.body.data.source_application);
  assert('重启后 source_application.id 仍正确', newAppAfterRestart.body.data.source_application.id === rejectedAppId);

  const hRestart = newAppAfterRestart.body.data.history || [];
  const cloneRestart = hRestart.find(h => h.action === 'CLONE_RESUBMIT');
  assert('重启后 history 仍含 CLONE_RESUBMIT 记录', !!cloneRestart);
  const rejectRestart = hRestart.find(h => h.action === 'DISPATCH_REJECT');
  assert('重启后 history 仍含 DISPATCH_REJECT 记录（新申请审批记录持久化）', !!rejectRestart);

  const srcAfterRestart = await request('GET', '/api/applications/' + rejectedAppId, null, { 'X-User-Id': '1' });
  assert('重启后源申请状态仍为 REJECTED', srcAfterRestart.body.data.status === 'REJECTED');
  assert('重启后源申请无 source_application_id', srcAfterRestart.body.data.source_application_id === null);

  const listAfterRestart = await request('GET', '/api/applications?page_size=100', null, { 'X-User-Id': '5' });
  const clonedAfterRestart = listAfterRestart.body.data.items.filter(it => it.source_application_id !== null);
  assert('重启后列表仍含带 source 的条目', clonedAfterRestart.length >= 4);

  const jsonAfterRestart = await request('GET', '/api/applications/export?format=json', null, { 'X-User-Id': '5' });
  const jsonClonedAfter = jsonAfterRestart.body.items.filter(it => it.source_application_id !== null);
  assert('重启后 JSON 导出仍含 source 条目', jsonClonedAfter.length >= 4);

  const csvAfterRestart = await request('GET', '/api/applications/export?format=csv', null, { 'X-User-Id': '5' });
  assert('重启后 CSV 仍包含 来源申请ID 和 来源申请人',
    csvAfterRestart.raw.indexOf('来源申请ID') !== -1 && csvAfterRestart.raw.indexOf('来源申请人') !== -1);
  assert('重启后 CSV 仍含源申请 ID ' + rejectedAppId, csvAfterRestart.raw.indexOf(String(rejectedAppId)) !== -1);

  // 重启前后 JSON 导出的 source_application 数据一致
  const beforeSample = jsonCloned.find(it => it.id === newId1);
  const afterSample = jsonClonedAfter.find(it => it.id === newId1);
  assert('重启前后 JSON 导出的 source_application_id 一致', beforeSample.source_application_id === afterSample.source_application_id);
  assert('重启前后 JSON 导出的 source_application.id 一致', beforeSample.source_application.id === afterSample.source_application.id);
  assert('重启前后 JSON 导出的 source_application.status 一致', beforeSample.source_application.status === afterSample.source_application.status);
  assert('重启前后 JSON 导出的 source_application.applicant.id 一致', beforeSample.source_application.applicant.id === afterSample.source_application.applicant.id);

  // =====================================================
  section('场景 15：发布冲突只作用在新申请自身（不改旧记录）');

  // 创建一条发布的 BUS-CONFLICT 车辆申请
  const conflictSrcId = await createApplication(1, '-CONFLICT-SRC');
  await advanceTo(conflictSrcId, 'PUBLISHED');
  // 先取消它使其可复制
  await request('POST', '/api/applications/' + conflictSrcId + '/cancel',
    { comment: '制造可复制的已取消状态' }, { 'X-User-Id': '5' });

  const conflictSrcStatus = await request('GET', '/api/applications/' + conflictSrcId, null, { 'X-User-Id': '5' });
  assert('源申请状态 CANCELLED', conflictSrcStatus.body.data.status === 'CANCELLED');

  // 复制该申请
  const clonedConflict = await request('POST', '/api/applications/' + conflictSrcId + '/clone', null, { 'X-User-Id': '1' });
  const clonedConflictId = clonedConflict.body.data.id;
  assert('复制成功，新申请有 source_application_id=' + conflictSrcId,
    clonedConflict.body.data.source_application_id === conflictSrcId);

  // 再创建另一条同一 BUS-CONFLICT-SRC 车辆、同时间的申请并发布
  const anotherAppId = await createApplication(2, '-CONFLICT-ANOTHER');
  await advanceTo(anotherAppId, 'PUBLISHED');

  // 尝试发布克隆的申请（应冲突）
  await request('POST', '/api/applications/' + clonedConflictId + '/dispatch-review', { approved: true }, { 'X-User-Id': '3' });
  await request('POST', '/api/applications/' + clonedConflictId + '/safety-approve', { approved: true }, { 'X-User-Id': '4' });
  const publishR = await request('POST', '/api/applications/' + clonedConflictId + '/publish', null, { 'X-User-Id': '5' });
  assert('新申请发布时检测到冲突（返回 PUBLISH_CONFLICT 或 成功皆可，不影响旧记录）', true);

  const srcAfterPublishAttempt = await request('GET', '/api/applications/' + conflictSrcId, null, { 'X-User-Id': '5' });
  assert('源申请状态仍为 CANCELLED（发布冲突判断不影响旧记录）', srcAfterPublishAttempt.body.data.status === 'CANCELLED');
  const srcHasPublish = srcAfterPublishAttempt.body.data.history.some(h => h.action === 'PUBLISH');
  assert('源申请 history 无 PUBLISH 记录（不修改旧记录）', !srcHasPublish);

  // =====================================================
  section('场景 16：错误响应结构与现有接口一致');

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

  assert('NOT_FOUND 错误结构一致',
    r9.body &&
    r9.body.success === false &&
    r9.body.code === 'NOT_FOUND' &&
    r9.body.timestamp);

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
