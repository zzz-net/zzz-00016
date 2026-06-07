const express = require('express');
const { initDb } = require('./db');
const { errorHandler, notFoundHandler, success } = require('./utils/response');
const applicationsRouter = require('./routes/applications');
const usersRouter = require('./routes/users');
const riskRulesRouter = require('./routes/riskRules');

const app = express();
const PORT = process.env.PORT || 3000;

initDb();

app.use(express.json({ limit: '1mb' }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.get('/health', (_req, res) => {
  success(res, { status: 'ok', service: 'school-bus-reroute-api', timestamp: new Date().toISOString() });
});

app.get('/', (_req, res) => {
  success(res, {
    name: '校车临时改线审批 API',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      users: 'GET /api/users, GET /api/users/me',
      applications: {
        create: 'POST /api/applications',
        list: 'GET /api/applications?status=&route_name=&start_date=&end_date=&page=&page_size=',
        reminders: 'GET /api/applications/reminders?timeout_status=all|pending|overdue&route_name=&status=',
        get: 'GET /api/applications/:id',
        dispatch_review: 'POST /api/applications/:id/dispatch-review',
        safety_approve: 'POST /api/applications/:id/safety-approve',
        publish: 'POST /api/applications/:id/publish',
        cancel: 'POST /api/applications/:id/cancel',
        clone_resubmit: 'POST /api/applications/:id/clone',
        export: 'GET /api/applications/export?format=json|csv&route_name=&start_date=&end_date='
      },
      risk_rules: {
        create: 'POST /api/risk-rules (admin)',
        list: 'GET /api/risk-rules?rule_type=&status=&page=&page_size=',
        get: 'GET /api/risk-rules/:id',
        update: 'PUT /api/risk-rules/:id (admin)',
        toggle: 'POST /api/risk-rules/:id/toggle (admin)',
        delete: 'DELETE /api/risk-rules/:id (admin)',
        hits_list: 'GET /api/risk-rules/hits?page=&page_size=',
        hits_by_rule: 'GET /api/risk-rules/:id/hits?page=&page_size=',
        export: 'GET /api/risk-rules/export?format=json|csv&rule_type=&status=',
        import: 'POST /api/risk-rules/import (admin)'
      }
    }
  });
});

app.use('/api/users', usersRouter);
app.use('/api/applications', applicationsRouter);
app.use('/api/risk-rules', riskRulesRouter);

app.use(notFoundHandler);
app.use(errorHandler);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log('========================================');
    console.log('  校车临时改线审批 API');
    console.log(`  服务地址: http://localhost:${PORT}`);
    console.log(`  健康检查: http://localhost:${PORT}/health`);
    console.log('========================================');
    console.log('');
    console.log('认证方式：请求头 X-User-Id = 用户ID');
    console.log('默认用户（执行 npm run init-db 初始化）：');
    console.log('  1 - 张老师   (teacher)');
    console.log('  2 - 李老师   (teacher)');
    console.log('  3 - 王调度   (dispatcher)');
    console.log('  4 - 赵安全员 (safety)');
    console.log('  5 - 陈主任   (admin)');
  });
}

module.exports = app;
