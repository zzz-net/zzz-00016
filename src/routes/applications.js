const express = require('express');
const { auth, requireRole } = require('../middleware/auth');
const { audit, log } = require('../middleware/audit');
const { success } = require('../utils/response');
const svc = require('../services/applicationService');

const router = express.Router();

router.post(
  '/',
  auth,
  requireRole('teacher', 'dispatcher', 'safety', 'admin'),
  audit('APPLICATION_CREATE'),
  (req, res, next) => {
    try {
      const app = svc.createApplication(req.user, req.body);
      success(res, app, '申请提交成功');
    } catch (err) { next(err); }
  }
);

router.get(
  '/',
  auth,
  audit('APPLICATION_LIST'),
  (req, res, next) => {
    try {
      const { status, route_name, start_date, end_date, page, page_size } = req.query;
      const result = svc.listApplications({
        status,
        route_name,
        start_date,
        end_date,
        page: page ? parseInt(page, 10) : 1,
        page_size: page_size ? parseInt(page_size, 10) : 20
      });
      success(res, result);
    } catch (err) { next(err); }
  }
);

router.get(
  '/reminders',
  auth,
  (req, res, next) => {
    try {
      const { timeout_status, route_name, status } = req.query;
      const result = svc.getReminders(req.user, { timeout_status, route_name, status });
      log('APPLICATION_REMINDERS_QUERY', {
        user: req.user,
        resource: req.baseUrl + req.path,
        detail: {
          operator_id: req.user.id,
          operator_role: req.user.role,
          filters: result.filters,
          hit_count: result.total,
          timeout_minutes: result.timeout_minutes,
          overdue_count: result.overdue_count,
          warning_count: result.warning_count
        },
        ip: req.ip
      });
      success(res, result);
    } catch (err) { next(err); }
  }
);

router.get(
  '/export',
  auth,
  audit('APPLICATION_EXPORT'),
  (req, res, next) => {
    try {
      const { format = 'json', route_name, start_date, end_date, status, applicant_id, has_cancel_remark } = req.query;
      const opts = {
        format,
        route_name,
        start_date,
        end_date,
        status,
        applicant_id,
        has_cancel_remark,
        user: req.user
      };
      if (format === 'csv') {
        const result = svc.exportApplications(opts);
        log('APPLICATION_EXPORT_RESULT', {
          user: req.user,
          resource: req.baseUrl + req.path,
          detail: {
            format: 'csv',
            filters: result.filters,
            count: result.count
          },
          ip: req.ip
        });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="applications_${Date.now()}.csv"`);
        return res.send('\uFEFF' + result.csv);
      }
      const data = svc.exportApplications({ ...opts, format: 'json' });
      log('APPLICATION_EXPORT_RESULT', {
        user: req.user,
        resource: req.baseUrl + req.path,
        detail: {
          format: 'json',
          filters: data.filters,
          count: data.count
        },
        ip: req.ip
      });
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="applications_${Date.now()}.json"`);
      return res.json(data);
    } catch (err) { next(err); }
  }
);

router.get(
  '/:id',
  auth,
  audit('APPLICATION_GET', (r) => parseInt(r.params.id, 10)),
  (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return next(new (require('../utils/response').AppError)('id 必须是数字', 'VALIDATION_ERROR', 400));
      }
      const app = svc.getApplicationById(id);
      if (!app) {
        return next(new (require('../utils/response').AppError)(`申请 ${id} 不存在`, 'NOT_FOUND', 404));
      }
      success(res, app);
    } catch (err) { next(err); }
  }
);

router.post(
  '/:id/dispatch-review',
  auth,
  requireRole('dispatcher', 'admin'),
  audit('APPLICATION_DISPATCH_REVIEW', (r) => parseInt(r.params.id, 10)),
  (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return next(new (require('../utils/response').AppError)('id 必须是数字', 'VALIDATION_ERROR', 400));
      }
      const { approved = true, comment } = req.body || {};
      const app = svc.dispatchReview(id, req.user, { approved: !!approved, comment });
      success(res, app, approved ? '调度复核通过' : '调度已驳回');
    } catch (err) { next(err); }
  }
);

router.post(
  '/:id/safety-approve',
  auth,
  requireRole('safety', 'admin'),
  audit('APPLICATION_SAFETY_APPROVE', (r) => parseInt(r.params.id, 10)),
  (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return next(new (require('../utils/response').AppError)('id 必须是数字', 'VALIDATION_ERROR', 400));
      }
      const { approved = true, comment } = req.body || {};
      const app = svc.safetyApprove(id, req.user, { approved: !!approved, comment });
      success(res, app, approved ? '安全审批通过' : '安全已驳回');
    } catch (err) { next(err); }
  }
);

router.post(
  '/:id/publish',
  auth,
  requireRole('admin'),
  audit('APPLICATION_PUBLISH', (r) => parseInt(r.params.id, 10)),
  (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return next(new (require('../utils/response').AppError)('id 必须是数字', 'VALIDATION_ERROR', 400));
      }
      const app = svc.publish(id, req.user);
      success(res, app, '发布成功');
    } catch (err) { next(err); }
  }
);

router.post(
  '/:id/cancel',
  auth,
  audit('APPLICATION_CANCEL', (r) => parseInt(r.params.id, 10)),
  (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return next(new (require('../utils/response').AppError)('id 必须是数字', 'VALIDATION_ERROR', 400));
      }
      const { comment } = req.body || {};
      const app = svc.cancelApplication(id, req.user, { comment });
      success(res, app, '取消成功');
    } catch (err) { next(err); }
  }
);

router.post(
  '/:id/clone',
  auth,
  audit('APPLICATION_CLONE_RESUBMIT', (r) => parseInt(r.params.id, 10)),
  (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return next(new (require('../utils/response').AppError)('id 必须是数字', 'VALIDATION_ERROR', 400));
      }
      const { applicant_id } = req.body || {};
      const app = svc.cloneApplication(id, req.user, { applicant_id });
      success(res, app, '复制再提交成功');
    } catch (err) { next(err); }
  }
);

module.exports = router;
