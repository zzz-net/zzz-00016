const http = require('http');

const BASE = 'http://localhost:3000';

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

function print(label, r) {
  console.log(`\n========== ${label} ==========`);
  console.log('Status:', r.status);
  console.log('Body:', JSON.stringify(r.body, null, 2));
}

(async () => {
  console.log('\n==== 校车临时改线审批 API 全流程测试 ====\n');

  // 0. 未认证
  print('[0] 未认证访问', await request('GET', '/api/applications'));

  // 1. 老师提交申请
  const r1 = await request('POST', '/api/applications', {
    route_name: '1号线',
    original_stops: ['东门站', '少年宫站', '图书馆站', '学校站'],
    new_stops: ['东门站', '人民广场站', '体育馆站', '学校站'],
    effective_start: '2026-06-10T07:00:00.000Z',
    effective_end: '2026-06-10T09:00:00.000Z',
    vehicle_id: 'BUS-A01',
    reason: '少年宫路段道路施工，临时绕行'
  }, { 'X-User-Id': '1' });
  print('[1] 张老师提交申请', r1);
  const appId = r1.body && r1.body.data && r1.body.data.id;
  console.log('申请 ID =', appId);

  // 2. 普通老师尝试调度复核（应失败）
  print('[2] 老师审批(应失败-PERMISSION_DENIED)',
    await request('POST', `/api/applications/${appId}/dispatch-review`, { approved: true }, { 'X-User-Id': '1' }));

  // 3. 调度复核通过
  print('[3] 王调度复核通过',
    await request('POST', `/api/applications/${appId}/dispatch-review`, { approved: true, comment: '绕行合理' }, { 'X-User-Id': '3' }));

  // 4. 安全审批通过
  print('[4] 赵安全员审批通过',
    await request('POST', `/api/applications/${appId}/safety-approve`, { approved: true, comment: '新线路无安全隐患' }, { 'X-User-Id': '4' }));

  // 5. 管理员发布
  print('[5] 陈主任发布',
    await request('POST', `/api/applications/${appId}/publish`, null, { 'X-User-Id': '5' }));

  // 6. 重复发布（幂等，应成功且无变化）
  print('[6] 重复发布（幂等）',
    await request('POST', `/api/applications/${appId}/publish`, null, { 'X-User-Id': '5' }));

  // 7. 详情查询（含完整历史和影响站点）
  print('[7] 申请详情（历史+影响站点）',
    await request('GET', `/api/applications/${appId}`, null, { 'X-User-Id': '1' }));

  // 8. 缺少前置审批就发布（第二个申请）
  const r8a = await request('POST', '/api/applications', {
    route_name: '2号线',
    original_stops: ['A', 'B', 'C'],
    new_stops: ['A', 'D', 'C'],
    effective_start: '2026-07-01T07:00:00.000Z',
    effective_end: '2026-07-01T09:00:00.000Z',
    vehicle_id: 'BUS-A02',
    reason: 'B站积水'
  }, { 'X-User-Id': '2' });
  print('[8a] 李老师提交第二个申请', r8a);
  const appId2 = r8a.body.data.id;
  print('[8b] 直接发布(应失败-INVALID_TRANSITION)',
    await request('POST', `/api/applications/${appId2}/publish`, null, { 'X-User-Id': '5' }));

  // 9. 冲突检测：创建与申请1同线路、同车辆、时间重叠的申请3，并尝试发布
  const r9a = await request('POST', '/api/applications', {
    route_name: '1号线',
    original_stops: ['东门站', '少年宫站', '图书馆站', '学校站'],
    new_stops: ['东门站', '中心公园站', '学校站'],
    effective_start: '2026-06-10T08:00:00.000Z',
    effective_end: '2026-06-10T10:00:00.000Z',
    vehicle_id: 'BUS-A01',
    reason: '临时加车'
  }, { 'X-User-Id': '1' });
  const appId3 = r9a.body.data.id;
  print('[9a] 提交冲突申请 id=' + appId3, r9a);
  await request('POST', `/api/applications/${appId3}/dispatch-review`, { approved: true }, { 'X-User-Id': '3' });
  await request('POST', `/api/applications/${appId3}/safety-approve`, { approved: true }, { 'X-User-Id': '4' });
  print('[9b] 发布冲突申请(应失败-PUBLISH_CONFLICT)',
    await request('POST', `/api/applications/${appId3}/publish`, null, { 'X-User-Id': '5' }));

  // 10. 参数校验失败
  print('[10] 参数校验失败(缺少必填)',
    await request('POST', '/api/applications', {}, { 'X-User-Id': '1' }));

  // 11. 不存在的申请
  print('[11] 查询不存在申请',
    await request('GET', '/api/applications/9999', null, { 'X-User-Id': '1' }));

  // 12. 404
  print('[12] 404接口',
    await request('GET', '/api/not-exist', null, { 'X-User-Id': '1' }));

  // 13. 列表查询（按状态/线路筛选）
  print('[13a] 列表查询全部',
    await request('GET', '/api/applications?page_size=10', null, { 'X-User-Id': '1' }));
  print('[13b] 按状态筛选 PUBLISHED',
    await request('GET', '/api/applications?status=PUBLISHED', null, { 'X-User-Id': '1' }));
  print('[13c] 按线路+日期筛选',
    await request('GET', '/api/applications?route_name=1号线&start_date=2026-06-01&end_date=2026-06-30', null, { 'X-User-Id': '1' }));

  // 14. 导出 JSON / CSV
  const r14a = await request('GET', '/api/applications/export?format=json&route_name=1号线', null, { 'X-User-Id': '1' });
  console.log('\n========== [14a] 导出 JSON ==========');
  console.log('Status:', r14a.status);
  console.log('Count:', r14a.body && r14a.body.count);

  const r14b = await request('GET', '/api/applications/export?format=csv', null, { 'X-User-Id': '1' });
  console.log('\n========== [14b] 导出 CSV ==========');
  console.log('Status:', r14b.status);
  console.log('CSV Preview:', r14b.raw.split('\r\n').slice(0, 3).join('\n'));

  // 15. 用户接口
  print('[15a] 用户列表', await request('GET', '/api/users', null, { 'X-User-Id': '1' }));
  print('[15b] 当前用户', await request('GET', '/api/users/me', null, { 'X-User-Id': '3' }));

  console.log('\n==== 测试完成 ====\n');
})().catch(console.error);
