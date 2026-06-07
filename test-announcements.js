const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const BASE = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, 'data', 'school-bus.db');

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
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

function assert(cond, label, detail = '') {
  if (cond) {
    console.log(`  ✅ PASS: ${label}`);
    return true;
  } else {
    console.error(`  ❌ FAIL: ${label} ${detail}`);
    process.exitCode = 1;
    return false;
  }
}

function printSection(title) {
  console.log(`\n========================================================`);
  console.log(`  ${title}`);
  console.log(`========================================================`);
}

function resetDb() {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  const wal = DB_PATH + '-wal';
  const shm = DB_PATH + '-shm';
  if (fs.existsSync(wal)) fs.unlinkSync(wal);
  if (fs.existsSync(shm)) fs.unlinkSync(shm);
}

function waitForServer(timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryIt = () => {
      http.get(BASE + '/health', (res) => {
        if (res.statusCode === 200) resolve();
        else if (Date.now() - start > timeoutMs) reject(new Error('server timeout'));
        else setTimeout(tryIt, 300);
      }).on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error('server timeout'));
        else setTimeout(tryIt, 300);
      });
    };
    tryIt();
  });
}

async function startServer() {
  const proc = spawn('node', [path.join(__dirname, 'src', 'server.js')], {
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, PORT: '3000' }
  });
  await waitForServer();
  return proc;
}

function stopServer(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.killed) return resolve();
    proc.on('exit', resolve);
    proc.kill('SIGTERM');
    setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); resolve(); }, 3000);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runTests() {
  let serverProc = null;
  let passCount = 0;
  let failCount = 0;
  const test = (cond, label, detail = '') => {
    const ok = assert(cond, label, detail);
    if (ok) passCount++; else failCount++;
    return ok;
  };

  try {
    printSection('初始化：重置数据库 + 启动服务');
    resetDb();
    require('./src/scripts/init-db');
    serverProc = await startServer();
    console.log('  ✅ 服务启动并就绪');

    printSection('前置：走完一条完整申请审批发布流程（张老师提交）');
    const rCreate = await request('POST', '/api/applications', {
      route_name: '公告测试1号线',
      original_stops: ['东门站', '少年宫站', '图书馆站', '学校站'],
      new_stops: ['东门站', '人民广场站', '体育馆站', '学校站'],
      effective_start: '2026-07-01T07:00:00.000Z',
      effective_end: '2026-07-01T09:00:00.000Z',
      vehicle_id: 'BUS-TEST01',
      reason: '公告测试：少年宫路段施工'
    }, { 'X-User-Id': '1' });
    test(rCreate.body && rCreate.body.code === 'OK', '张老师提交申请成功',
      rCreate.body && rCreate.body.code);
    const appId = rCreate.body.data.id;

    await request('POST', `/api/applications/${appId}/dispatch-review`,
      { approved: true }, { 'X-User-Id': '3' });
    await request('POST', `/api/applications/${appId}/safety-approve`,
      { approved: true }, { 'X-User-Id': '4' });
    const rPub = await request('POST', `/api/applications/${appId}/publish`,
      null, { 'X-User-Id': '5' });
    test(rPub.body && rPub.body.data.status === 'PUBLISHED',
      '申请已发布 (PUBLISHED)', rPub.body && rPub.body.data && rPub.body.data.status);

    printSection('【场景1】生成公告 - admin 成功生成 v1 公告');
    const rAnn1 = await request('POST', '/api/announcements', {
      application_id: appId,
      remark: '请各位老师和家长注意改线安排，少年宫路段施工绕行'
    }, { 'X-User-Id': '5' });
    test(rAnn1.status === 200 && rAnn1.body && rAnn1.body.code === 'OK',
      'admin 生成 v1 公告 HTTP 200 + code=OK',
      `status=${rAnn1.status} code=${rAnn1.body && rAnn1.body.code}`);
    const annId = rAnn1.body.data.id;
    test(rAnn1.body.data.version === 1,
      '公告版本号自动分配为 v1', `实际=${rAnn1.body.data.version}`);
    test(rAnn1.body.data.route_name === '公告测试1号线',
      '公告线路正确', rAnn1.body.data.route_name);
    test(rAnn1.body.data.affected_stops
      && rAnn1.body.data.affected_stops.removed.includes('少年宫站')
      && rAnn1.body.data.affected_stops.removed.includes('图书馆站'),
      '影响站点包含被移除站点', JSON.stringify(rAnn1.body.data.affected_stops));
    test(rAnn1.body.data.affected_stops
      && rAnn1.body.data.affected_stops.added.includes('人民广场站')
      && rAnn1.body.data.affected_stops.added.includes('体育馆站'),
      '影响站点包含新增站点', JSON.stringify(rAnn1.body.data.affected_stops));
    test(rAnn1.body.data.remark
      && rAnn1.body.data.remark.includes('少年宫路段施工绕行'),
      '公告备注正确', rAnn1.body.data.remark);
    test(rAnn1.body.data.created_by && rAnn1.body.data.created_by.id === 5,
      'admin 视角返回 created_by.id=5', JSON.stringify(rAnn1.body.data.created_by));
    test(typeof rAnn1.body.data.applicant_id === 'number',
      'admin 视角返回 applicant_id', `${rAnn1.body.data.applicant_id}`);

    printSection('【场景2】重复冲突 - 同申请+同版本重复生成返回稳定错误码 + 现有摘要');
    const rDup = await request('POST', '/api/announcements', {
      application_id: appId,
      version: 1,
      remark: '重复尝试'
    }, { 'X-User-Id': '5' });
    test(rDup.status === 409,
      '重复生成 HTTP 409', `实际=${rDup.status}`);
    test(rDup.body && rDup.body.code === 'ANNOUNCEMENT_DUPLICATE',
      '错误码稳定为 ANNOUNCEMENT_DUPLICATE',
      `实际=${rDup.body && rDup.body.code}`);
    test(rDup.body.details && rDup.body.details.existing
      && rDup.body.details.existing.id === annId
      && rDup.body.details.existing.version === 1
      && rDup.body.details.existing.application_id === appId
      && rDup.body.details.existing.route_name,
      'details.existing 返回现有公告摘要（id/version/application_id/route_name）',
      JSON.stringify(rDup.body && rDup.body.details && rDup.body.details.existing));
    test(!('affected_stops' in (rDup.body.details && rDup.body.details.existing || {})),
      '摘要不暴露详细数据（如 affected_stops）',
      JSON.stringify(rDup.body && rDup.body.details && rDup.body.details.existing));

    printSection('【场景2扩展】自动分配版本号，v2 公告可正常生成');
    const rAnn2 = await request('POST', '/api/announcements', {
      application_id: appId,
      remark: 'v2 更新：改线时间延长一天'
    }, { 'X-User-Id': '5' });
    test(rAnn2.body && rAnn2.body.code === 'OK' && rAnn2.body.data.version === 2,
      '再次省略 version 时自动分配 v2',
      `code=${rAnn2.body && rAnn2.body.code} version=${rAnn2.body && rAnn2.body.data && rAnn2.body.data.version}`);

    printSection('【场景2扩展】未发布的申请不能生成公告');
    const rUnpublishedCreate = await request('POST', '/api/applications', {
      route_name: '未发布测试线',
      original_stops: ['A', 'B'],
      new_stops: ['A', 'C'],
      effective_start: '2026-08-01T07:00:00.000Z',
      effective_end: '2026-08-01T09:00:00.000Z',
      reason: '未发布测试'
    }, { 'X-User-Id': '2' });
    const unpubId = rUnpublishedCreate.body.data.id;
    const rAnnUnpub = await request('POST', '/api/announcements', {
      application_id: unpubId
    }, { 'X-User-Id': '5' });
    test(rAnnUnpub.status === 409 && rAnnUnpub.body.code === 'INVALID_STATUS',
      '未发布申请生成公告返回 INVALID_STATUS (409)',
      `status=${rAnnUnpub.status} code=${rAnnUnpub.body && rAnnUnpub.body.code}`);

    printSection('【场景2扩展】非 admin 不能生成公告');
    const rAnnDispatcher = await request('POST', '/api/announcements', {
      application_id: appId
    }, { 'X-User-Id': '3' });
    test(rAnnDispatcher.status === 403 && rAnnDispatcher.body.code === 'PERMISSION_DENIED',
      'dispatcher 生成公告返回 PERMISSION_DENIED (403)');

    const rAnnTeacher = await request('POST', '/api/announcements', {
      application_id: appId
    }, { 'X-User-Id': '1' });
    test(rAnnTeacher.status === 403 && rAnnTeacher.body.code === 'PERMISSION_DENIED',
      'teacher 生成公告返回 PERMISSION_DENIED (403)');

    printSection('【场景3】重启后查询 - 公告 SQLite 持久化验证');
    console.log('  停止服务...');
    await stopServer(serverProc);
    serverProc = null;
    await sleep(500);
    console.log('  重新启动服务...');
    serverProc = await startServer();
    console.log('  服务重启完成，查询公告...');

    const rAfterRestart = await request('GET', `/api/announcements/${annId}`,
      null, { 'X-User-Id': '5' });
    test(rAfterRestart.status === 200
      && rAfterRestart.body.code === 'OK'
      && rAfterRestart.body.data.id === annId
      && rAfterRestart.body.data.version === 1
      && rAfterRestart.body.data.route_name === '公告测试1号线',
      '重启后 v1 公告数据完整（id/version/route_name 不变）',
      `status=${rAfterRestart.status} data=${JSON.stringify(rAfterRestart.body && rAfterRestart.body.data)}`);

    const rListAfterRestart = await request('GET',
      `/api/announcements/application/${appId}`, null, { 'X-User-Id': '5' });
    test(rListAfterRestart.body && rListAfterRestart.body.data.total === 2,
      '重启后申请下仍有 2 个版本公告（v1, v2）',
      `total=${rListAfterRestart.body && rListAfterRestart.body.data && rListAfterRestart.body.data.total}`);

    printSection('【场景4】普通老师越权查看 - teacher 角色权限隔离');
    const rOtherTeacherGet = await request('GET', `/api/announcements/${annId}`,
      null, { 'X-User-Id': '2' });
    test(rOtherTeacherGet.status === 403
      && rOtherTeacherGet.body.code === 'PERMISSION_DENIED',
      '李老师（id=2，非申请人）查看张老师的公告返回 403 PERMISSION_DENIED',
      `status=${rOtherTeacherGet.status} code=${rOtherTeacherGet.body && rOtherTeacherGet.body.code}`);

    const rOwnerTeacherGet = await request('GET', `/api/announcements/${annId}`,
      null, { 'X-User-Id': '1' });
    test(rOwnerTeacherGet.status === 200 && rOwnerTeacherGet.body.code === 'OK',
      '张老师（id=1，申请人本人）可正常查看自己的公告',
      `status=${rOwnerTeacherGet.status} code=${rOwnerTeacherGet.body && rOwnerTeacherGet.body.code}`);

    const ownerData = rOwnerTeacherGet.body.data;
    test(!('applicant_id' in ownerData),
      'teacher 视角响应不暴露 applicant_id',
      Object.keys(ownerData).join(','));
    test(!(ownerData.created_by && typeof ownerData.created_by.id === 'number'),
      'teacher 视角 created_by 不暴露用户 id（仅姓名或不返回 id）',
      JSON.stringify(ownerData.created_by));
    test(!Object.keys(ownerData).some(k => k.includes('rule') || k.includes('filter')),
      'teacher 视角不暴露内部规则配置或后台筛选条件字段',
      Object.keys(ownerData).join(','));

    const rOtherTeacherList = await request('GET', '/api/announcements?page_size=100',
      null, { 'X-User-Id': '2' });
    test(rOtherTeacherList.body.data.total === 0,
      '李老师列表接口看不到张老师的公告（total=0）',
      `total=${rOtherTeacherList.body.data.total}`);
    test(rOtherTeacherList.body.data.filters
      && rOtherTeacherList.body.data.filters.scope === 'teacher: 仅本人申请相关公告',
      'teacher 列表 filters 显示角色范围但不含其他老师信息',
      JSON.stringify(rOtherTeacherList.body.data.filters));

    const rOwnerTeacherList = await request('GET', '/api/announcements?page_size=100',
      null, { 'X-User-Id': '1' });
    test(rOwnerTeacherList.body.data.total >= 2,
      '张老师列表接口能看到自己申请的 2 条公告',
      `total=${rOwnerTeacherList.body.data.total}`);

    const rDispatcherList = await request('GET', '/api/announcements?page_size=100',
      null, { 'X-User-Id': '3' });
    test(rDispatcherList.body.data.total >= 2
      && !('scope' in (rDispatcherList.body.data.filters || {})),
      '调度员列表接口能看到全部公告（无 teacher scope 限制）',
      `total=${rDispatcherList.body.data.total} filters=${JSON.stringify(rDispatcherList.body.data.filters)}`);

    printSection('【场景5】导出权限 - JSON/CSV 按角色隔离 + audit_logs');
    const rAdminExportJson = await request('GET',
      '/api/announcements/export?format=json', null, { 'X-User-Id': '5' });
    test(rAdminExportJson.status === 200
      && rAdminExportJson.body.count >= 2,
      'admin JSON 导出 >= 2 条（全部可见）',
      `count=${rAdminExportJson.body && rAdminExportJson.body.count}`);
    test(rAdminExportJson.body.filter_summary
      && rAdminExportJson.body.filter_summary.includes('admin'),
      'JSON 导出包含 filter_summary',
      rAdminExportJson.body && rAdminExportJson.body.filter_summary);

    const rTeacherExportJson = await request('GET',
      '/api/announcements/export?format=json', null, { 'X-User-Id': '1' });
    test(rTeacherExportJson.body.count >= 2,
      '张老师 JSON 导出本人公告 >= 2 条',
      `count=${rTeacherExportJson.body && rTeacherExportJson.body.count}`);
    test(rTeacherExportJson.body.items.every(it =>
      !('applicant_id' in it) && !(it.created_by && typeof it.created_by.id === 'number')
    ), 'teacher 导出的每条公告均脱敏（无 applicant_id、无 created_by.id）',
      JSON.stringify(rTeacherExportJson.body.items[0]));

    const rOtherTeacherExportJson = await request('GET',
      '/api/announcements/export?format=json', null, { 'X-User-Id': '2' });
    test(rOtherTeacherExportJson.body.count === 0,
      '李老师 JSON 导出 0 条（只能看自己的，他没提交过公告相关申请）',
      `count=${rOtherTeacherExportJson.body && rOtherTeacherExportJson.body.count}`);

    const rTeacherExportCsv = await request('GET',
      '/api/announcements/export?format=csv', null, { 'X-User-Id': '1' });
    test(rTeacherExportCsv.status === 200
      && rTeacherExportCsv.raw.startsWith('\uFEFF'),
      'teacher CSV 导出 HTTP 200 + UTF-8 BOM',
      `starts_with_BOM=${rTeacherExportCsv.raw.startsWith('\uFEFF')}`);
    const csvLines = rTeacherExportCsv.raw.trim().split(/\r?\n/);
    test(csvLines.length >= 3,
      'teacher CSV 至少 3 行（表头 + v1 + v2）',
      `lines=${csvLines.length}`);
    test(csvLines[0].includes('ID') && csvLines[0].includes('版本')
      && csvLines[0].includes('线路') && csvLines[0].includes('备注'),
      'CSV 表头包含 ID/版本/线路/备注 等固定列',
      csvLines[0]);

    printSection('【场景5扩展】audit_logs 中存在公告导出记录');
    const { getDb } = require('./src/db');
    const db = getDb();
    const exportLogs = db.prepare(
      "SELECT * FROM audit_logs WHERE action = 'ANNOUNCEMENT_EXPORT_RESULT' ORDER BY id DESC LIMIT 5"
    ).all();
    test(exportLogs.length >= 3,
      `audit_logs 中至少 3 条 ANNOUNCEMENT_EXPORT_RESULT（admin/张老师/李老师各导出一次）`,
      `实际=${exportLogs.length}`);
    test(exportLogs.every(l => l.detail && l.detail.includes('format')),
      '每条导出审计日志 detail 含 format 字段',
      exportLogs.map(l => l.detail).join(' | '));

    const createLogs = db.prepare(
      "SELECT * FROM audit_logs WHERE action = 'ANNOUNCEMENT_CREATED' ORDER BY id ASC"
    ).all();
    test(createLogs.length === 2,
      `audit_logs 中有 2 条 ANNOUNCEMENT_CREATED（v1 + v2）`,
      `实际=${createLogs.length}`);

    printSection('【附加】边界用例');
    const rNotFound = await request('POST', '/api/announcements', {
      application_id: 999999
    }, { 'X-User-Id': '5' });
    test(rNotFound.status === 404 && rNotFound.body.code === 'NOT_FOUND',
      '申请不存在时返回 NOT_FOUND (404)');

    const rBadParam = await request('POST', '/api/announcements', {
      remark: '缺 application_id'
    }, { 'X-User-Id': '5' });
    test(rBadParam.status === 400 && rBadParam.body.code === 'VALIDATION_ERROR',
      '缺少必填参数返回 VALIDATION_ERROR (400)');

    const rAnnNotFound = await request('GET', '/api/announcements/999999',
      null, { 'X-User-Id': '5' });
    test(rAnnNotFound.status === 404 && rAnnNotFound.body.code === 'NOT_FOUND',
      '公告不存在返回 NOT_FOUND (404)');

    const rByAppNotFound = await request('GET', '/api/announcements/application/999999',
      null, { 'X-User-Id': '5' });
    test(rByAppNotFound.status === 404 && rByAppNotFound.body.code === 'NOT_FOUND',
      '按不存在的申请查公告返回 NOT_FOUND (404)');

    printSection('测试完成');
    console.log(`  通过: ${passCount}  失败: ${failCount}`);
    if (failCount > 0) {
      console.log('  ⚠️  有测试失败，请检查上方输出');
    } else {
      console.log('  🎉 全部测试通过！');
    }
  } finally {
    if (serverProc) await stopServer(serverProc);
  }
}

runTests().catch((err) => {
  console.error('\n❌ 测试脚本异常:', err);
  process.exit(1);
});
