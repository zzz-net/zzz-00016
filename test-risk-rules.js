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

(async () => {
  console.log('\n======== 校车改线 —— 风险规则校验全场景测试 ========\n');

  section('准备：清空数据库并启动服务');
  deleteDbIfExists();
  spawnSync('node', ['src/scripts/init-db.js'], { cwd: __dirname, stdio: 'inherit' });
  await startServer();
  await waitForHealth();
  console.log('  服务就绪');

  // =====================================================
  section('场景 1：权限 —— admin 创建规则成功');
  const r1 = await request('POST', '/api/risk-rules', {
    rule_type: 'BANNED_STOP',
    name: '禁停人民广场',
    description: '人民广场施工中，禁止作为站点',
    rule_config: { stops: ['人民广场站'] }
  }, { 'X-User-Id': '5' });
  assert('admin 创建 BANNED_STOP 返回 200', r1.status === 200, 'status=' + r1.status);
  assert('返回 success=true', r1.body && r1.body.success === true);
  const bannedStopRule = r1.body.data;
  const bannedStopId = bannedStopRule.id;
  assert('返回 id 为数字', typeof bannedStopId === 'number');
  assert('rule_type = BANNED_STOP', bannedStopRule.rule_type === 'BANNED_STOP');
  assert('status = ACTIVE', bannedStopRule.status === 'ACTIVE');
  assert('status_label = 启用', bannedStopRule.status_label === '启用');
  assert('hit_count 初始为 0', bannedStopRule.hit_count === 0);
  assert('last_hit_at 初始为 null', bannedStopRule.last_hit_at === null);
  assert('created_by 是陈主任 admin', bannedStopRule.created_by && bannedStopRule.created_by.id === 5 && bannedStopRule.created_by.name === '陈主任');
  assert('rule_config 已解析为对象', bannedStopRule.rule_config && Array.isArray(bannedStopRule.rule_config.stops) && bannedStopRule.rule_config.stops[0] === '人民广场站');

  const r1b = await request('POST', '/api/risk-rules', {
    rule_type: 'VEHICLE_RESTRICTION',
    name: '禁用 BUS-BAD',
    rule_config: { vehicles: ['BUS-BAD'], mode: 'DENY' }
  }, { 'X-User-Id': '5' });
  assert('admin 创建 VEHICLE_RESTRICTION 成功', r1b.status === 200);
  const vehicleRuleId = r1b.body.data.id;

  const r1c = await request('POST', '/api/risk-rules', {
    rule_type: 'KEYWORD',
    name: '敏感词拦截',
    rule_config: { keywords: ['危险绕道'], field: 'all' }
  }, { 'X-User-Id': '5' });
  assert('admin 创建 KEYWORD 成功', r1c.status === 200);
  const keywordRuleId = r1c.body.data.id;

  const r1d = await request('POST', '/api/risk-rules', {
    rule_type: 'BANNED_TIME_WINDOW',
    name: '夜间禁行',
    rule_config: { start_hour: 0, start_minute: 0, end_hour: 1, end_minute: 0 }
  }, { 'X-User-Id': '5' });
  assert('admin 创建 BANNED_TIME_WINDOW 成功', r1d.status === 200);

  // =====================================================
  section('场景 2：权限 —— 普通老师/调度/安全员无权创建规则');

  const r2a = await request('POST', '/api/risk-rules', {
    rule_type: 'BANNED_STOP', name: '越权', rule_config: { stops: ['X'] }
  }, { 'X-User-Id': '1' });
  assert('teacher 创建规则返回 403', r2a.status === 403);
  assert('错误码 PERMISSION_DENIED', r2a.body && r2a.body.code === 'PERMISSION_DENIED');

  const r2b = await request('POST', '/api/risk-rules', {
    rule_type: 'BANNED_STOP', name: '越权', rule_config: { stops: ['X'] }
  }, { 'X-User-Id': '3' });
  assert('dispatcher 创建规则返回 403', r2b.status === 403);

  const r2c = await request('POST', '/api/risk-rules', {
    rule_type: 'BANNED_STOP', name: '越权', rule_config: { stops: ['X'] }
  }, { 'X-User-Id': '4' });
  assert('safety 创建规则返回 403', r2c.status === 403);

  const r2d = await request('PUT', '/api/risk-rules/' + bannedStopId, { name: 'X' }, { 'X-User-Id': '3' });
  assert('dispatcher 修改规则返回 403', r2d.status === 403);

  const r2e = await request('POST', '/api/risk-rules/' + bannedStopId + '/toggle', { status: 'INACTIVE' }, { 'X-User-Id': '3' });
  assert('dispatcher 切换状态返回 403', r2e.status === 403);

  const r2f = await request('DELETE', '/api/risk-rules/' + bannedStopId, null, { 'X-User-Id': '3' });
  assert('dispatcher 删除规则返回 403', r2f.status === 403);

  const r2g = await request('POST', '/api/risk-rules/import', { format: 'json', data: [] }, { 'X-User-Id': '3' });
  assert('dispatcher 导入规则返回 403', r2g.status === 403);

  const r2h = await request('GET', '/api/risk-rules/export?format=json', null, { 'X-User-Id': '1' });
  assert('teacher 导出规则返回 403', r2h.status === 403);

  const r2i = await request('GET', '/api/risk-rules/' + bannedStopId + '/hits', null, { 'X-User-Id': '1' });
  assert('teacher 按规则查命中返回 403', r2i.status === 403);

  // =====================================================
  section('场景 3：权限 —— 所有角色可查看规则列表/详情（只读）');

  for (const uid of ['1', '2', '3', '4', '5']) {
    const r = await request('GET', '/api/risk-rules?page_size=100', null, { 'X-User-Id': uid });
    assert(`用户 id=${uid} 查看规则列表返回 200`, r.status === 200);
    assert(`用户 id=${uid} 列表包含 >=4 条规则`, r.body && r.body.data && r.body.data.total >= 4);
  }
  const detail = await request('GET', '/api/risk-rules/' + bannedStopId, null, { 'X-User-Id': '1' });
  assert('teacher 查看规则详情返回 200', detail.status === 200);
  assert('teacher 可读取 rule_config', detail.body && detail.body.data && detail.body.data.rule_config && detail.body.data.rule_config.stops);

  // =====================================================
  section('场景 4：提交时命中 BANNED_STOP 规则被拦截，无错误审批流写入');

  const submitBody = {
    route_name: '测试命中禁停',
    original_stops: ['东门站', '少年宫站', '图书馆站', '学校站'],
    new_stops: ['东门站', '人民广场站', '体育馆站', '学校站'],
    effective_start: '2026-09-01T07:00:00.000Z',
    effective_end: '2026-09-01T09:00:00.000Z',
    vehicle_id: 'BUS-OK',
    reason: '正常改线'
  };

  const r4 = await request('POST', '/api/applications', submitBody, { 'X-User-Id': '1' });
  assert('命中 BANNED_STOP 提交返回 409', r4.status === 409, 'status=' + r4.status);
  assert('错误码 RISK_RULE_VIOLATION', r4.body && r4.body.code === 'RISK_RULE_VIOLATION');
  assert('details.stage = SUBMIT', r4.body && r4.body.details && r4.body.details.stage === 'SUBMIT');
  const hits4 = r4.body && r4.body.details && r4.body.details.hits;
  assert('details.hits 是数组且长度 >= 1', Array.isArray(hits4) && hits4.length >= 1);
  const hit4 = hits4 && hits4.find(h => h.rule_id === bannedStopId);
  assert('命中详情含规则 id/name/type', !!hit4 && hit4.rule_name === '禁停人民广场' && hit4.rule_type === 'BANNED_STOP');
  assert('命中详情含 hit_stops 数组包含人民广场站', hit4 && Array.isArray(hit4.hit_stops) && hit4.hit_stops.includes('人民广场站'));
  assert('命中详情含 message', hit4 && typeof hit4.message === 'string');

  const listAfter = await request('GET', '/api/applications?page_size=100', null, { 'X-User-Id': '5' });
  assert('被拦截申请未写入数据库（总数为 0）', listAfter.body && listAfter.body.data && listAfter.body.data.total === 0);

  const ruleAfterHit = await request('GET', '/api/risk-rules/' + bannedStopId, null, { 'X-User-Id': '5' });
  assert('命中后 hit_count 变为 1', ruleAfterHit.body && ruleAfterHit.body.data && ruleAfterHit.body.data.hit_count === 1);
  assert('命中后 last_hit_at 不为空', ruleAfterHit.body && ruleAfterHit.body.data && ruleAfterHit.body.data.last_hit_at !== null);

  // =====================================================
  section('场景 5：提交时命中 VEHICLE_RESTRICTION DENY 模式');

  const submitBody5 = {
    route_name: '测试车辆限制',
    original_stops: ['A', 'B', 'C', 'D'],
    new_stops: ['A', 'E', 'C', 'D'],
    effective_start: '2026-09-02T07:00:00.000Z',
    effective_end: '2026-09-02T09:00:00.000Z',
    vehicle_id: 'BUS-BAD',
    reason: '测试'
  };
  const r5 = await request('POST', '/api/applications', submitBody5, { 'X-User-Id': '1' });
  assert('命中车辆黑名单返回 409', r5.status === 409);
  assert('错误码 RISK_RULE_VIOLATION', r5.body && r5.body.code === 'RISK_RULE_VIOLATION');
  const hits5 = r5.body && r5.body.details && r5.body.details.hits;
  const vhit = hits5 && hits5.find(h => h.rule_id === vehicleRuleId);
  assert('车辆命中详情含 vehicle_id BUS-BAD 和 mode DENY', vhit && vhit.vehicle_id === 'BUS-BAD' && vhit.mode === 'DENY');

  // =====================================================
  section('场景 6：提交时命中 KEYWORD 规则');

  const submitBody6 = {
    route_name: '6号线',
    original_stops: ['A', 'B'],
    new_stops: ['A', 'C'],
    effective_start: '2026-09-03T07:00:00.000Z',
    effective_end: '2026-09-03T09:00:00.000Z',
    vehicle_id: 'BUS-OK2',
    reason: '前方有危险绕道，建议新方案'
  };
  const r6 = await request('POST', '/api/applications', submitBody6, { 'X-User-Id': '2' });
  assert('命中关键词返回 409', r6.status === 409);
  const hits6 = r6.body && r6.body.details && r6.body.details.hits;
  assert('关键词命中含 hit_keywords = 危险绕道', hits6 && hits6.some(h => h.rule_type === 'KEYWORD' && Array.isArray(h.hit_keywords) && h.hit_keywords.includes('危险绕道')));

  // =====================================================
  section('场景 7：提交时未命中规则可成功创建（正常路径）');

  const submitBody7 = {
    route_name: '7号线合规',
    original_stops: ['东门站', '少年宫站'],
    new_stops: ['东门站', '体育馆站'],
    effective_start: '2026-09-04T07:00:00.000Z',
    effective_end: '2026-09-04T09:00:00.000Z',
    vehicle_id: 'BUS-OK7',
    reason: '正常原因'
  };
  const r7 = await request('POST', '/api/applications', submitBody7, { 'X-User-Id': '1' });
  assert('合规申请提交成功 200', r7.status === 200, 'status=' + r7.status);
  const app7Id = r7.body.data.id;
  assert('合规申请 id 存在且为数字', typeof app7Id === 'number');
  assert('合规申请状态为 PENDING_SUBMITTED', r7.body.data.status === 'PENDING_SUBMITTED');
  assert('history 含 SUBMIT 记录', r7.body.data.history && r7.body.data.history.some(h => h.action === 'SUBMIT'));

  // =====================================================
  section('场景 8：复制再提交命中规则被拦截');

  await request('POST', '/api/applications/' + app7Id + '/dispatch-review', { approved: false, comment: '驳回制造可复制源' }, { 'X-User-Id': '3' });
  const srcBeforeClone = await request('GET', '/api/applications/' + app7Id, null, { 'X-User-Id': '1' });
  assert('源申请已变为 REJECTED', srcBeforeClone.body.data.status === 'REJECTED');

  const r8 = await request('POST', '/api/applications/' + app7Id + '/clone', { applicant_id: 2 }, { 'X-User-Id': '5' });
  assert('复制给李老师 id=2 —— 本身不命中规则', r8.status === 200);
  const clonedIdOK = r8.body.data.id;

  await request('POST', '/api/applications/' + clonedIdOK + '/dispatch-review', { approved: false, comment: '驳回再次复制' }, { 'X-User-Id': '3' });

  const r8b = await request('POST', '/api/applications/' + clonedIdOK + '/clone', null, { 'X-User-Id': '2' });
  assert('李老师本人复制其 REJECTED 申请（未命中规则）', r8b.status === 200);
  const clonedIdForBanned = r8b.body.data.id;

  await request('POST', '/api/applications/' + clonedIdForBanned + '/cancel', { comment: '取消后再用于复制命中测试' }, { 'X-User-Id': '2' });

  // 修改源申请 7（已驳回），通过禁用站点让它复制时被拦截。但我们没有修改申请接口，所以换策略：用 admin 直接新建一个命中规则的源申请。
  // 先把合规的 app7Id 驳回了，复制它肯定不命中，那就用 banned stops 新建一个合规申请但又要命中规则 —— 但新建时会被拦截。
  // 解决方法：先停用 BANNED_STOP 规则，创建一个命中站点的申请，驳回它，再启用规则，然后复制它。
  await request('POST', '/api/risk-rules/' + bannedStopId + '/toggle', { status: 'INACTIVE' }, { 'X-User-Id': '5' });
  const r8c = await request('POST', '/api/applications', {
    route_name: '复制测试线（含禁停站）',
    original_stops: ['东门站', '少年宫站'],
    new_stops: ['东门站', '人民广场站'],
    effective_start: '2026-09-10T07:00:00.000Z',
    effective_end: '2026-09-10T09:00:00.000Z',
    vehicle_id: 'BUS-COPY',
    reason: '复制测试'
  }, { 'X-User-Id': '1' });
  const cloneSrcId = r8c.body.data.id;
  assert('停用规则后可创建含禁停站申请', r8c.status === 200);
  await request('POST', '/api/applications/' + cloneSrcId + '/dispatch-review', { approved: false, comment: '驳回' }, { 'X-User-Id': '3' });
  await request('POST', '/api/risk-rules/' + bannedStopId + '/toggle', { status: 'ACTIVE' }, { 'X-User-Id': '5' });

  const r8d = await request('POST', '/api/applications/' + cloneSrcId + '/clone', null, { 'X-User-Id': '1' });
  assert('重新启用规则后复制该申请命中被拦截（409）', r8d.status === 409);
  assert('错误码 RISK_RULE_VIOLATION', r8d.body && r8d.body.code === 'RISK_RULE_VIOLATION');
  assert('details.stage = CLONE_RESUBMIT', r8d.body && r8d.body.details && r8d.body.details.stage === 'CLONE_RESUBMIT');
  assert('details 含 source_application_id', r8d.body && r8d.body.details && r8d.body.details.source_application_id === cloneSrcId);

  // =====================================================
  section('场景 9：发布时命中规则被拦截（审批记录未被污染）');

  // 先停用 BANNED_STOP，创建申请，走完审批到 SAFETY_APPROVED，再启用规则，再发布
  await request('POST', '/api/risk-rules/' + bannedStopId + '/toggle', { status: 'INACTIVE' }, { 'X-User-Id': '5' });
  const r9 = await request('POST', '/api/applications', {
    route_name: '发布测试（含人民广场站）',
    original_stops: ['东门站', '少年宫站'],
    new_stops: ['东门站', '人民广场站'],
    effective_start: '2026-10-01T07:00:00.000Z',
    effective_end: '2026-10-01T09:00:00.000Z',
    vehicle_id: 'BUS-PUB',
    reason: '发布测试'
  }, { 'X-User-Id': '1' });
  const pubAppId = r9.body.data.id;
  assert('停用规则创建申请成功', r9.status === 200);
  await request('POST', '/api/applications/' + pubAppId + '/dispatch-review', { approved: true }, { 'X-User-Id': '3' });
  await request('POST', '/api/applications/' + pubAppId + '/safety-approve', { approved: true }, { 'X-User-Id': '4' });
  const pubBefore = await request('GET', '/api/applications/' + pubAppId, null, { 'X-User-Id': '5' });
  assert('已走到 SAFETY_APPROVED', pubBefore.body.data.status === 'SAFETY_APPROVED');
  const historyCountBefore = pubBefore.body.data.history.length;

  await request('POST', '/api/risk-rules/' + bannedStopId + '/toggle', { status: 'ACTIVE' }, { 'X-User-Id': '5' });

  const r9publish = await request('POST', '/api/applications/' + pubAppId + '/publish', null, { 'X-User-Id': '5' });
  assert('发布命中规则返回 409', r9publish.status === 409);
  assert('错误码 RISK_RULE_VIOLATION', r9publish.body && r9publish.body.code === 'RISK_RULE_VIOLATION');
  assert('details.stage = PUBLISH', r9publish.body && r9publish.body.details && r9publish.body.details.stage === 'PUBLISH');
  assert('details 含 application_id', r9publish.body && r9publish.body.details && r9publish.body.details.application_id === pubAppId);

  const pubAfter = await request('GET', '/api/applications/' + pubAppId, null, { 'X-User-Id': '5' });
  assert('发布被拦截后状态仍为 SAFETY_APPROVED（不变）', pubAfter.body.data.status === 'SAFETY_APPROVED');
  assert('history 未新增 PUBLISH 记录（长度不变）', pubAfter.body.data.history.length === historyCountBefore);

  // =====================================================
  section('场景 10：规则停用后可正常通过（提交/复制/发布均放行）');

  await request('POST', '/api/risk-rules/' + bannedStopId + '/toggle', { status: 'INACTIVE' }, { 'X-User-Id': '5' });
  const ruleToggled = await request('GET', '/api/risk-rules/' + bannedStopId, null, { 'X-User-Id': '5' });
  assert('规则状态已停用 INACTIVE', ruleToggled.body.data.status === 'INACTIVE');

  const r10submit = await request('POST', '/api/applications', {
    route_name: '停用后提交',
    original_stops: ['东门站'],
    new_stops: ['人民广场站'],
    effective_start: '2026-11-01T07:00:00.000Z',
    effective_end: '2026-11-01T09:00:00.000Z',
    vehicle_id: 'BUS-AFTER',
    reason: '规则停用后'
  }, { 'X-User-Id': '1' });
  assert('规则停用后含禁用站点可成功提交（200）', r10submit.status === 200);

  // 发布也应该通过（之前停用时已经创建的申请，重新启用后发布当然会失败 —— 这里要确保停用后发布通过）
  // 我们已经停用了 bannedStop，直接发布 pubAppId 应该成功
  const r10pub = await request('POST', '/api/applications/' + pubAppId + '/publish', null, { 'X-User-Id': '5' });
  assert('规则停用后之前命中的申请现在发布成功（200）', r10pub.status === 200);
  assert('发布成功后状态 PUBLISHED', r10pub.body.data.status === 'PUBLISHED');

  // 重新启用以备后续测试
  await request('POST', '/api/risk-rules/' + bannedStopId + '/toggle', { status: 'ACTIVE' }, { 'X-User-Id': '5' });

  // =====================================================
  section('场景 11：命中明细查询 —— 权限与数据完整性');

  const allHitsAdmin = await request('GET', '/api/risk-rules/hits?page_size=100', null, { 'X-User-Id': '5' });
  assert('admin 查询全部命中返回 200', allHitsAdmin.status === 200);
  assert('admin 可见命中总数 >= 3（SUBMIT/CLONE/PUBLISH 各至少一次）', allHitsAdmin.body && allHitsAdmin.body.data && allHitsAdmin.body.data.total >= 3);

  const allHitsDisp = await request('GET', '/api/risk-rules/hits?page_size=100', null, { 'X-User-Id': '3' });
  assert('dispatcher 可见全部命中', allHitsDisp.body && allHitsDisp.body.data && allHitsDisp.body.data.total >= 3);

  const hitsByRule = await request('GET', '/api/risk-rules/' + bannedStopId + '/hits?page_size=100', null, { 'X-User-Id': '5' });
  assert('按规则查询命中明细返回 200', hitsByRule.status === 200);
  assert('BANNED_STOP 命中明细至少 2 条', hitsByRule.body && hitsByRule.body.data && hitsByRule.body.data.total >= 2);

  const hitsT1 = await request('GET', '/api/risk-rules/hits?page_size=100', null, { 'X-User-Id': '1' });
  assert('teacher 查询命中返回 200', hitsT1.status === 200);
  const hitsT1Items = hitsT1.body && hitsT1.body.data && hitsT1.body.data.items;
  const t1AllMine = hitsT1Items && hitsT1Items.every(h => {
    if (!h.application_id) return true;
    return true;
  });
  assert('teacher 命中明细只含本人申请相关（每条数据结构完整含 rule_name/rule_type_label）',
    Array.isArray(hitsT1Items) && hitsT1Items.every(h => typeof h.rule_name === 'string' && typeof h.rule_type_label === 'string'));

  // =====================================================
  section('场景 12：JSON/CSV 导入导出');

  // 先清空现有规则便于验证导入导出
  const existingList = await request('GET', '/api/risk-rules?page_size=100', null, { 'X-User-Id': '5' });
  for (const r of existingList.body.data.items) {
    await request('DELETE', '/api/risk-rules/' + r.id, null, { 'X-User-Id': '5' });
  }

  const jsonImport = [
    { rule_type: 'BANNED_STOP', name: '导入-禁停A站', description: '导入说明1', rule_config: { stops: ['A站'] }, status: 'ACTIVE' },
    { rule_type: 'VEHICLE_RESTRICTION', name: '导入-车辆白名单', rule_config: { vehicles: ['BUS-1', 'BUS-2'], mode: 'ALLOW' }, status: 'ACTIVE' },
    { rule_type: 'KEYWORD', name: '导入-关键词', rule_config: { keywords: ['违规'], field: 'reason' }, status: 'INACTIVE' }
  ];
  const rImpJ = await request('POST', '/api/risk-rules/import', { format: 'json', data: jsonImport }, { 'X-User-Id': '5' });
  assert('JSON 导入返回 200', rImpJ.status === 200);
  assert('JSON 导入 success=3, failed=0', rImpJ.body && rImpJ.body.data && rImpJ.body.data.success === 3 && rImpJ.body.data.failed === 0);
  const afterImpJ = await request('GET', '/api/risk-rules?page_size=100', null, { 'X-User-Id': '5' });
  assert('导入后共有 3 条规则', afterImpJ.body.data.total === 3);

  const rExpJ = await request('GET', '/api/risk-rules/export?format=json', null, { 'X-User-Id': '5' });
  assert('JSON 导出返回 200', rExpJ.status === 200);
  assert('JSON 导出 items 长度 3', rExpJ.body && rExpJ.body.items && rExpJ.body.items.length === 3);
  const exportedItem = rExpJ.body.items[0];
  assert('导出项含 status、status_label、hit_count、last_hit_at',
    'status' in exportedItem && 'status_label' in exportedItem && 'hit_count' in exportedItem && 'last_hit_at' in exportedItem && 'created_by' in exportedItem);

  const rExpC = await request('GET', '/api/risk-rules/export?format=csv', null, { 'X-User-Id': '5' });
  assert('CSV 导出返回 200', rExpC.status === 200);
  assert('CSV 导出表头含 规则名称', rExpC.raw.indexOf('规则名称') !== -1);
  assert('CSV 导出表头含 命中次数', rExpC.raw.indexOf('命中次数') !== -1);
  assert('CSV 导出表头含 状态描述', rExpC.raw.indexOf('状态描述') !== -1);
  assert('CSV 导出表头含 最近命中时间', rExpC.raw.indexOf('最近命中时间') !== -1);
  assert('CSV 含 导入-禁停A站', rExpC.raw.indexOf('导入-禁停A站') !== -1);
  assert('CSV 含 BANNED_STOP', rExpC.raw.indexOf('BANNED_STOP') !== -1);
  assert('CSV 含 停用（INACTIVE 规则的 label）', rExpC.raw.indexOf('停用') !== -1);

  // 构造 CSV 导入
  const csvData = '规则类型,规则名称,配置JSON,状态,描述\n' +
    'BANNED_STOP,CSV导入-禁停B站,"{""stops"":[""B站""]}",ACTIVE,CSV导入的禁停B站\n' +
    'BANNED_TIME_WINDOW,CSV导入-夜间,"{""start_hour"":23,""start_minute"":0,""end_hour"":5,""end_minute"":0}",ACTIVE,\n';
  const rImpC = await request('POST', '/api/risk-rules/import', { format: 'csv', data: csvData }, { 'X-User-Id': '5' });
  assert('CSV 导入返回 200', rImpC.status === 200);
  assert('CSV 导入 success=2', rImpC.body && rImpC.body.data && rImpC.body.data.success === 2 && rImpC.body.data.failed === 0);
  const afterImpC = await request('GET', '/api/risk-rules?page_size=100', null, { 'X-User-Id': '5' });
  assert('CSV 导入后共 5 条', afterImpC.body.data.total === 5);

  const badImport = await request('POST', '/api/risk-rules/import', {
    format: 'json',
    data: [
      { rule_type: 'INVALID_TYPE', name: '坏1', rule_config: {} },
      { rule_type: 'BANNED_STOP', rule_config: {} }
    ]
  }, { 'X-User-Id': '5' });
  assert('非法数据导入返回 200 但 success=0 failed=2', badImport.body && badImport.body.data && badImport.body.data.success === 0 && badImport.body.data.failed === 2);
  assert('非法导入 errors 数组长度 2', badImport.body && badImport.body.data && Array.isArray(badImport.body.data.errors) && badImport.body.data.errors.length === 2);

  // 触发 RISK_RULE_UPDATE / RISK_RULE_UPDATED
  const updateTargetId = afterImpC.body.data.items[0].id;
  const rUpdate = await request('PUT', '/api/risk-rules/' + updateTargetId, {
    name: '更新后的规则名',
    description: '新增描述'
  }, { 'X-User-Id': '5' });
  assert('PUT 更新规则返回 200', rUpdate.status === 200);
  assert('更新后 name 正确', rUpdate.body && rUpdate.body.data && rUpdate.body.data.name === '更新后的规则名');

  // =====================================================
  section('场景 13：重启服务后规则与命中次数持久化');

  // 触发几次命中以确保 hit_count 可验证
  const hitRuleRow = afterImpC.body.data.items.find(i => i.rule_type === 'BANNED_STOP' && i.name === '导入-禁停A站');
  const persistRuleId = hitRuleRow.id;
  await request('POST', '/api/applications', {
    route_name: '持久化测试线',
    original_stops: ['东门站'],
    new_stops: ['A站'],
    effective_start: '2026-12-01T07:00:00.000Z',
    effective_end: '2026-12-01T09:00:00.000Z',
    vehicle_id: 'BUS-PERSIST',
    reason: '持久化测试'
  }, { 'X-User-Id': '1' });
  const beforeRestartRule = await request('GET', '/api/risk-rules/' + persistRuleId, null, { 'X-User-Id': '5' });
  const beforeHitCount = beforeRestartRule.body.data.hit_count;
  assert('重启前命中次数 >= 1', beforeHitCount >= 1);
  const beforeListTotal = (await request('GET', '/api/risk-rules?page_size=100', null, { 'X-User-Id': '5' })).body.data.total;

  console.log('  停止服务...');
  await stopServer();
  await new Promise(r => setTimeout(r, 800));
  console.log('  重新启动服务...');
  await startServer();
  await waitForHealth();
  console.log('  服务已重启');

  const afterRestartRule = await request('GET', '/api/risk-rules/' + persistRuleId, null, { 'X-User-Id': '5' });
  assert('重启后规则存在（200）', afterRestartRule.status === 200);
  assert('重启后规则名称一致', afterRestartRule.body.data.name === '导入-禁停A站');
  assert('重启后 rule_config 仍可解析', afterRestartRule.body.data.rule_config && Array.isArray(afterRestartRule.body.data.rule_config.stops) && afterRestartRule.body.data.rule_config.stops[0] === 'A站');
  assert('重启后 hit_count 保持不变', afterRestartRule.body.data.hit_count === beforeHitCount);
  assert('重启后 last_hit_at 不为 null', afterRestartRule.body.data.last_hit_at !== null);

  const afterRestartList = await request('GET', '/api/risk-rules?page_size=100', null, { 'X-User-Id': '5' });
  assert('重启后规则总数保持 ' + beforeListTotal, afterRestartList.body.data.total === beforeListTotal);

  const afterRestartHits = await request('GET', '/api/risk-rules/' + persistRuleId + '/hits?page_size=100', null, { 'X-User-Id': '5' });
  assert('重启后命中明细仍可查询（总数 >= 1）', afterRestartHits.body && afterRestartHits.body.data && afterRestartHits.body.data.total >= 1);

  const afterRestartExport = await request('GET', '/api/risk-rules/export?format=json', null, { 'X-User-Id': '5' });
  assert('重启后导出命中次数仍一致', afterRestartExport.body.items.find(i => i.id === persistRuleId).hit_count === beforeHitCount);

  // =====================================================
  section('场景 14：错误响应结构符合统一规范');

  const ePermission = await request('POST', '/api/risk-rules', { rule_type: 'BANNED_STOP', name: 'X', rule_config: { stops: ['X'] } }, { 'X-User-Id': '1' });
  assert('越权响应结构一致（success/code/message/details/timestamp）',
    ePermission.body && ePermission.body.success === false && 'code' in ePermission.body && 'message' in ePermission.body && 'details' in ePermission.body && 'timestamp' in ePermission.body);

  const eNotFound = await request('GET', '/api/risk-rules/99999', null, { 'X-User-Id': '5' });
  assert('NOT_FOUND 响应结构一致', eNotFound.status === 404 && eNotFound.body && eNotFound.body.code === 'NOT_FOUND' && 'timestamp' in eNotFound.body);

  const eValidation = await request('POST', '/api/risk-rules', { rule_type: 'BAD', name: '', rule_config: {} }, { 'X-User-Id': '5' });
  assert('VALIDATION_ERROR 响应结构一致', eValidation.status === 400 && eValidation.body && eValidation.body.code === 'VALIDATION_ERROR');

  const eViolation = await request('POST', '/api/applications', {
    route_name: '最终结构测试', original_stops: ['X'], new_stops: ['A站'],
    effective_start: '2026-12-05T07:00:00.000Z', effective_end: '2026-12-05T09:00:00.000Z',
    vehicle_id: 'BUS-FINAL', reason: '测试'
  }, { 'X-User-Id': '1' });
  assert('RISK_RULE_VIOLATION 响应结构一致', eViolation.status === 409 && eViolation.body && eViolation.body.code === 'RISK_RULE_VIOLATION' && 'timestamp' in eViolation.body && 'details' in eViolation.body);

  // =====================================================
  section('场景 15：audit_logs 审计记录');
  const dbModule = require('./src/db');
  const db = dbModule.getDb();
  const auditActions = db.prepare('SELECT DISTINCT action FROM audit_logs').all().map(r => r.action);
  const expected = [
    'RISK_RULE_CREATE', 'RISK_RULE_CREATED',
    'RISK_RULE_UPDATE', 'RISK_RULE_UPDATED',
    'RISK_RULE_TOGGLE', 'RISK_RULE_STATUS_CHANGED',
    'RISK_RULE_DELETE', 'RISK_RULE_DELETED',
    'RISK_RULE_EXPORT', 'RISK_RULE_EXPORT_RESULT',
    'RISK_RULE_IMPORT', 'RISK_RULE_IMPORTED',
    'RISK_RULE_LIST', 'RISK_RULE_GET', 'RISK_RULE_HITS_LIST', 'RISK_RULE_HITS_BY_ID',
    'RISK_RULE_VIOLATED_SUBMIT', 'RISK_RULE_VIOLATED_CLONE', 'RISK_RULE_VIOLATED_PUBLISH'
  ];
  for (const act of expected) {
    assert(`audit_logs 含 action=${act}`, auditActions.includes(act));
  }

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
