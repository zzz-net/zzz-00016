const express = require('express');
const { auth, requireRole } = require('../middleware/auth');
const { audit, log } = require('../middleware/audit');
const { success } = require('../utils/response');
const svc = require('../services/riskRuleService');

const router = express.Router();

router.post(
  '/',
  auth,
  requireRole('admin'),
  audit('RISK_RULE_CREATE'),
  (req, res, next) => {
    try {
      const rule = svc.createRule(req.user, req.body);
      log('RISK_RULE_CREATED', {
        user: req.user,
        resource: req.baseUrl + req.path,
        resourceId: rule.id,
        detail: { rule_id: rule.id, rule_type: rule.rule_type, name: rule.name, status: rule.status },
        ip: req.ip
      });
      success(res, rule, '风险规则创建成功');
    } catch (err) { next(err); }
  }
);

router.get(
  '/',
  auth,
  audit('RISK_RULE_LIST'),
  (req, res, next) => {
    try {
      const { rule_type, status, page, page_size } = req.query;
      const result = svc.listRules({
        rule_type,
        status,
        page: page ? parseInt(page, 10) : 1,
        page_size: page_size ? parseInt(page_size, 10) : 20
      });
      success(res, result);
    } catch (err) { next(err); }
  }
);

router.get(
  '/hits',
  auth,
  audit('RISK_RULE_HITS_LIST'),
  (req, res, next) => {
    try {
      const { page, page_size } = req.query;
      const result = svc.listRuleHitsForUser(req.user, {
        page: page ? parseInt(page, 10) : 1,
        page_size: page_size ? parseInt(page_size, 10) : 20
      });
      success(res, result);
    } catch (err) { next(err); }
  }
);

router.get(
  '/export',
  auth,
  requireRole('admin', 'dispatcher', 'safety'),
  audit('RISK_RULE_EXPORT'),
  (req, res, next) => {
    try {
      const { format = 'json', rule_type, status } = req.query;
      const opts = { format, rule_type, status };
      if (format === 'csv') {
        const result = svc.exportRules(opts);
        log('RISK_RULE_EXPORT_RESULT', {
          user: req.user,
          resource: req.baseUrl + req.path,
          detail: { format: 'csv', filters: result.filters, count: result.count },
          ip: req.ip
        });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="risk_rules_${Date.now()}.csv"`);
        return res.send('\uFEFF' + result.csv);
      }
      const data = svc.exportRules({ ...opts, format: 'json' });
      log('RISK_RULE_EXPORT_RESULT', {
        user: req.user,
        resource: req.baseUrl + req.path,
        detail: { format: 'json', filters: data.filters, count: data.count },
        ip: req.ip
      });
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="risk_rules_${Date.now()}.json"`);
      return res.json(data);
    } catch (err) { next(err); }
  }
);

router.post(
  '/import',
  auth,
  requireRole('admin'),
  audit('RISK_RULE_IMPORT'),
  (req, res, next) => {
    try {
      const { format = 'json', data } = req.body || {};
      const result = svc.importRules(req.user, format, data);
      log('RISK_RULE_IMPORTED', {
        user: req.user,
        resource: req.baseUrl + req.path,
        detail: { format, success: result.success, failed: result.failed, created_ids: result.created_ids, errors: result.errors },
        ip: req.ip
      });
      success(res, result, `导入完成：成功 ${result.success} 条，失败 ${result.failed} 条`);
    } catch (err) { next(err); }
  }
);

router.get(
  '/:id',
  auth,
  audit('RISK_RULE_GET', (r) => parseInt(r.params.id, 10)),
  (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return next(new (require('../utils/response').AppError)('id 必须是数字', 'VALIDATION_ERROR', 400));
      }
      const rule = svc.getRuleById(id);
      if (!rule) {
        return next(new (require('../utils/response').AppError)(`规则 ${id} 不存在`, 'NOT_FOUND', 404));
      }
      success(res, rule);
    } catch (err) { next(err); }
  }
);

router.put(
  '/:id',
  auth,
  requireRole('admin'),
  audit('RISK_RULE_UPDATE', (r) => parseInt(r.params.id, 10)),
  (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return next(new (require('../utils/response').AppError)('id 必须是数字', 'VALIDATION_ERROR', 400));
      }
      const before = svc.getRuleById(id);
      const rule = svc.updateRule(id, req.user, req.body);
      log('RISK_RULE_UPDATED', {
        user: req.user,
        resource: req.baseUrl + req.path,
        resourceId: id,
        detail: { rule_id: id, before, after: rule, changes: req.body },
        ip: req.ip
      });
      success(res, rule, '风险规则更新成功');
    } catch (err) { next(err); }
  }
);

router.post(
  '/:id/toggle',
  auth,
  requireRole('admin'),
  audit('RISK_RULE_TOGGLE', (r) => parseInt(r.params.id, 10)),
  (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return next(new (require('../utils/response').AppError)('id 必须是数字', 'VALIDATION_ERROR', 400));
      }
      const { status } = req.body || {};
      const before = svc.getRuleById(id);
      const rule = svc.toggleRuleStatus(id, req.user, status);
      log('RISK_RULE_STATUS_CHANGED', {
        user: req.user,
        resource: req.baseUrl + req.path,
        resourceId: id,
        detail: { rule_id: id, before_status: before ? before.status : null, after_status: rule.status },
        ip: req.ip
      });
      success(res, rule, `规则已${rule.status === 'ACTIVE' ? '启用' : '停用'}`);
    } catch (err) { next(err); }
  }
);

router.delete(
  '/:id',
  auth,
  requireRole('admin'),
  audit('RISK_RULE_DELETE', (r) => parseInt(r.params.id, 10)),
  (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return next(new (require('../utils/response').AppError)('id 必须是数字', 'VALIDATION_ERROR', 400));
      }
      const before = svc.getRuleById(id);
      const result = svc.deleteRule(id, req.user);
      log('RISK_RULE_DELETED', {
        user: req.user,
        resource: req.baseUrl + req.path,
        resourceId: id,
        detail: { rule_id: id, deleted_rule: before },
        ip: req.ip
      });
      success(res, result, '风险规则删除成功');
    } catch (err) { next(err); }
  }
);

router.get(
  '/:id/hits',
  auth,
  requireRole('admin', 'dispatcher', 'safety'),
  audit('RISK_RULE_HITS_BY_ID', (r) => parseInt(r.params.id, 10)),
  (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return next(new (require('../utils/response').AppError)('id 必须是数字', 'VALIDATION_ERROR', 400));
      }
      const { page, page_size } = req.query;
      const result = svc.getRuleHits(id, {
        page: page ? parseInt(page, 10) : 1,
        page_size: page_size ? parseInt(page_size, 10) : 20
      });
      success(res, result);
    } catch (err) { next(err); }
  }
);

module.exports = router;
