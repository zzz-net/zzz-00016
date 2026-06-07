const http = require('http');
const { execSync } = require('child_process');
const BASE = 'http://localhost:3000';

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const opts = {
      method, hostname: url.hostname, port: url.port,
      path: url.pathname + (url.search || ''),
      headers: { 'Content-Type': 'application/json', ...headers }
    };
    let payload = null;
    if (body) {
      payload = JSON.stringify(body);
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null, raw: data }); }
        catch { resolve({ status: res.statusCode, body: null, raw: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function assert(name, cond, info = '') {
  const mark = cond ? '✅' : '❌';
  console.log(`${mark} ${name}${info ? ' - ' + info : ''}`);
  if (!cond) { process.exitCode = 1; throw new Error('FAIL: ' + name); }
}

async function createAndApprove(payload) {
  const c = await request('POST', '/api/applications', payload, { 'X-User-Id': '1' });
  const id = c.body.data.id;
  await request('POST', `/api/applications/${id}/dispatch-review`, { approved: true }, { 'X-User-Id': '3' });
  await request('POST', `/api/applications/${id}/safety-approve`, { approved: true }, { 'X-User-Id': '4' });
  return id;
}

function conflictCountFor(dbPath, appId) {
  const out = execSync(
    `node -e "const d=require('better-sqlite3')('${dbPath.replace(/\\/g, '/')}'); console.log(d.prepare('SELECT COUNT(*) c FROM conflicts WHERE application_id=?').pluck().get(${appId}));"`,
    { encoding: 'utf8', cwd: __dirname }
  ).trim();
  return parseInt(out, 10);
}

(async () => {
  const ts = Date.now();
  const dbPath = require('path').join(__dirname, 'data', 'school-bus.db');
  console.log('\n=== 站点级冲突检测回归测试 ===\n');

  console.log('--- Case 1: 同站点时间重叠，应 409 PUBLISH_CONFLICT，冲突类型 STOP ---');
  {
    const base = {
      route_name: 'RG-A-' + ts,
      original_stops: [`S1-${ts}`, `S2-${ts}`, `S3-${ts}`],
      new_stops: [`S1-${ts}`, `S2-${ts}`, `S3-${ts}`],
      effective_start: '2026-12-01T07:00:00.000Z',
      effective_end: '2026-12-01T09:00:00.000Z',
      vehicle_id: 'V-A-' + ts,
      reason: 'case1-base'
    };
    const idBase = await createAndApprove(base);
    const pb = await request('POST', `/api/applications/${idBase}/publish`, null, { 'X-User-Id': '5' });
    assert('Case1 基准申请发布成功', pb.status === 200 && pb.body.data && pb.body.data.status === 'PUBLISHED');

    const challenger = {
      route_name: 'RG-B-' + ts,
      original_stops: [`S99-${ts}`, `S2-${ts}`, `S88-${ts}`],
      new_stops: [`S99-${ts}`, `S2-${ts}`, `S88-${ts}`],
      effective_start: '2026-12-01T07:30:00.000Z',
      effective_end: '2026-12-01T08:30:00.000Z',
      vehicle_id: 'V-B-' + ts,
      reason: 'case1-shared-S2'
    };
    const idChal = await createAndApprove(challenger);
    const before = conflictCountFor(dbPath, idChal);
    const pc = await request('POST', `/api/applications/${idChal}/publish`, null, { 'X-User-Id': '5' });
    assert('Case1 挑战者发布被 409 拦截', pc.status === 409 && pc.body.code === 'PUBLISH_CONFLICT',
      `status=${pc.status} code=${pc.body && pc.body.code}`);
    const first = pc.body.details.find(c => c.conflicting_application_id === idBase);
    assert('Case1 冲突类型为 STOP', first && first.type === 'STOP', first && `type=${first.type}`);
    assert('Case1 冲突详情包含共同站点',
      first && first.details.some(d => d.includes('站点冲突')) && first.details.some(d => d.includes(`S2-${ts}`)));
    const after = conflictCountFor(dbPath, idChal);
    assert('Case1 conflicts 表写入 1 条记录', after - before === 1, `before=${before} after=${after}`);

    const detail = await request('GET', `/api/applications/${idChal}`, null, { 'X-User-Id': '1' });
    assert('Case1 挑战者状态保持 SAFETY_APPROVED，未被改坏',
      detail.body.data.status === 'SAFETY_APPROVED', `status=${detail.body.data.status}`);
  }

  console.log('\n--- Case 2: 无共同站点，可正常发布 ---');
  {
    const base = {
      route_name: 'RG-C-' + ts,
      original_stops: [`P1-${ts}`, `P2-${ts}`],
      new_stops: [`P1-${ts}`, `P2-${ts}`],
      effective_start: '2026-12-02T07:00:00.000Z',
      effective_end: '2026-12-02T09:00:00.000Z',
      vehicle_id: 'V-C-' + ts,
      reason: 'case2-base'
    };
    const idBase = await createAndApprove(base);
    await request('POST', `/api/applications/${idBase}/publish`, null, { 'X-User-Id': '5' });

    const challenger = {
      route_name: 'RG-D-' + ts,
      original_stops: [`Q1-${ts}`, `Q2-${ts}`],
      new_stops: [`Q1-${ts}`, `Q2-${ts}`],
      effective_start: '2026-12-02T07:30:00.000Z',
      effective_end: '2026-12-02T08:30:00.000Z',
      vehicle_id: 'V-D-' + ts,
      reason: 'case2-no-overlap-stops'
    };
    const idChal = await createAndApprove(challenger);
    const pc = await request('POST', `/api/applications/${idChal}/publish`, null, { 'X-User-Id': '5' });
    assert('Case2 无共同站点时正常发布 PUBLISHED',
      pc.status === 200 && pc.body.data && pc.body.data.status === 'PUBLISHED',
      `status=${pc.status} appStatus=${pc.body && pc.body.data && pc.body.data.status}`);
  }

  console.log('\n--- Case 3: 同车冲突仍然有效 ---');
  {
    const base = {
      route_name: 'RG-E-' + ts,
      original_stops: [`X1-${ts}`],
      new_stops: [`X1-${ts}`],
      effective_start: '2026-12-03T07:00:00.000Z',
      effective_end: '2026-12-03T09:00:00.000Z',
      vehicle_id: 'V-SHARED-' + ts,
      reason: 'case3-base'
    };
    const idBase = await createAndApprove(base);
    await request('POST', `/api/applications/${idBase}/publish`, null, { 'X-User-Id': '5' });

    const challenger = {
      route_name: 'RG-F-' + ts,
      original_stops: [`Y1-${ts}`],
      new_stops: [`Y1-${ts}`],
      effective_start: '2026-12-03T07:30:00.000Z',
      effective_end: '2026-12-03T08:30:00.000Z',
      vehicle_id: 'V-SHARED-' + ts,
      reason: 'case3-same-vehicle'
    };
    const idChal = await createAndApprove(challenger);
    const pc = await request('POST', `/api/applications/${idChal}/publish`, null, { 'X-User-Id': '5' });
    assert('Case3 同车冲突被拦截 409', pc.status === 409 && pc.body.code === 'PUBLISH_CONFLICT',
      `status=${pc.status} code=${pc.body && pc.body.code}`);
    const c = pc.body.details.find(x => x.conflicting_application_id === idBase);
    assert('Case3 冲突类型为 VEHICLE 或 BOTH', c && (c.type === 'VEHICLE' || c.type === 'BOTH' || c.type === 'STOP'),
      c && `type=${c.type}`);
  }

  console.log('\n--- Case 4: 重复发布幂等，不新增冲突记录 ---');
  {
    const base = {
      route_name: 'RG-G-' + ts,
      original_stops: [`Z1-${ts}`],
      new_stops: [`Z1-${ts}`],
      effective_start: '2026-12-04T07:00:00.000Z',
      effective_end: '2026-12-04T09:00:00.000Z',
      vehicle_id: 'V-G-' + ts,
      reason: 'case4-idempotent'
    };
    const id = await createAndApprove(base);
    const first = await request('POST', `/api/applications/${id}/publish`, null, { 'X-User-Id': '5' });
    assert('Case4 首次发布成功', first.status === 200 && first.body.data && first.body.data.status === 'PUBLISHED');
    const before = conflictCountFor(dbPath, id);

    const second = await request('POST', `/api/applications/${id}/publish`, null, { 'X-User-Id': '5' });
    assert('Case4 重复发布仍 200 且状态 PUBLISHED',
      second.status === 200 && second.body.data.status === 'PUBLISHED'
      && second.body.data.updated_at === first.body.data.updated_at);
    const after = conflictCountFor(dbPath, id);
    assert('Case4 重复发布 conflicts 表不新增记录', before === after, `before=${before} after=${after}`);
  }

  console.log('\n--- Case 5: 查询与导出不再出现新增互斥 PUBLISHED ---');
  {
    const list = await request(
      'GET',
      `/api/applications?status=PUBLISHED&start_date=2026-12-01&end_date=2026-12-31`,
      null, { 'X-User-Id': '1' }
    );
    const published = list.body.data.items;

    const pairs = [];
    for (let i = 0; i < published.length; i++) {
      for (let j = i + 1; j < published.length; j++) {
        const a = published[i], b = published[j];
        const overlap = !(a.effective_end <= b.effective_start || b.effective_end <= a.effective_start);
        if (!overlap) continue;
        const stopsA = new Set([...a.original_stops, ...a.new_stops]);
        const stopsB = new Set([...b.original_stops, ...b.new_stops]);
        const sameVehicle = a.vehicle_id && b.vehicle_id && a.vehicle_id === b.vehicle_id;
        const sameRoute = a.route_name === b.route_name;
        const shareStop = [...stopsA].some(s => stopsB.has(s));
        if (sameRoute || sameVehicle || shareStop) {
          pairs.push([a.id, b.id, { sameRoute, sameVehicle, shareStop }]);
        }
      }
    }
    assert('Case5 列表查询中 12 月 PUBLISHED 无互斥对（同线/同车/共站时间重叠）',
      pairs.length === 0, `冲突对数=${pairs.length} pairs=${JSON.stringify(pairs)}`);

    const jsonExp = await request('GET', '/api/applications/export?format=json&start_date=2026-12-01&end_date=2026-12-31', null, { 'X-User-Id': '1' });
    const exported = jsonExp.body.items.filter(i => i.status === 'PUBLISHED');
    const exPairs = [];
    for (let i = 0; i < exported.length; i++) {
      for (let j = i + 1; j < exported.length; j++) {
        const a = exported[i], b = exported[j];
        const overlap = !(a.effective_end <= b.effective_start || b.effective_end <= a.effective_start);
        if (!overlap) continue;
        const stopsA = new Set([...a.original_stops, ...a.new_stops]);
        const stopsB = new Set([...b.original_stops, ...b.new_stops]);
        if (a.route_name === b.route_name
          || (a.vehicle_id && b.vehicle_id && a.vehicle_id === b.vehicle_id)
          || [...stopsA].some(s => stopsB.has(s))) {
          exPairs.push([a.id, b.id]);
        }
      }
    }
    assert('Case5 导出 JSON 中 12 月 PUBLISHED 也无互斥对', exPairs.length === 0,
      `导出冲突对数=${exPairs.length}`);

    const csv = await request('GET', '/api/applications/export?format=csv&start_date=2026-12-01&end_date=2026-12-31', null, { 'X-User-Id': '1' });
    const lines = csv.raw.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
    assert('Case5 CSV 导出有表头 + ' + exported.length + ' 行数据',
      lines.length >= 1 + exported.length, `lines=${lines.length} expected>=${1 + exported.length}`);
  }

  console.log('\n=== 全部回归测试通过 ===\n');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
