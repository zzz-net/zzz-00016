const express = require('express');
const { auth, requireRole } = require('../middleware/auth');
const { audit, log } = require('../middleware/audit');
const { success } = require('../utils/response');
const svc = require('../services/announcementService');

const router = express.Router();

router.post(
  '/',
  auth,
  requireRole('admin'),
  audit('ANNOUNCEMENT_CREATE'),
  (req, res, next) => {
    try {
      const ann = svc.createAnnouncement(req.user, req.body);
      success(res, ann, '公告生成成功');
    } catch (err) { next(err); }
  }
);

router.get(
  '/',
  auth,
  audit('ANNOUNCEMENT_LIST'),
  (req, res, next) => {
    try {
      const { route_name, start_date, end_date, page, page_size } = req.query;
      const result = svc.listAnnouncements(req.user, {
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
  '/export',
  auth,
  audit('ANNOUNCEMENT_EXPORT'),
  (req, res, next) => {
    try {
      const { format = 'json', route_name, start_date, end_date } = req.query;
      const opts = { format, route_name, start_date, end_date, user: req.user };

      if (format === 'csv') {
        const result = svc.exportAnnouncements(req.user, { ...opts, format: 'csv' });
        log('ANNOUNCEMENT_EXPORT_RESULT', {
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
        res.setHeader('Content-Disposition', `attachment; filename="announcements_${Date.now()}.csv"`);
        return res.send('\uFEFF' + result.csv);
      }

      const data = svc.exportAnnouncements(req.user, { ...opts, format: 'json' });
      log('ANNOUNCEMENT_EXPORT_RESULT', {
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
      res.setHeader('Content-Disposition', `attachment; filename="announcements_${Date.now()}.json"`);
      return res.json(data);
    } catch (err) { next(err); }
  }
);

router.get(
  '/application/:applicationId',
  auth,
  audit('ANNOUNCEMENT_LIST_BY_APPLICATION', (r) => parseInt(r.params.applicationId, 10)),
  (req, res, next) => {
    try {
      const applicationId = parseInt(req.params.applicationId, 10);
      if (isNaN(applicationId)) {
        return next(new (require('../utils/response').AppError)('applicationId 必须是数字', 'VALIDATION_ERROR', 400));
      }
      const result = svc.listAnnouncementsByApplication(applicationId, req.user);
      success(res, result);
    } catch (err) { next(err); }
  }
);

router.get(
  '/:id',
  auth,
  audit('ANNOUNCEMENT_GET', (r) => parseInt(r.params.id, 10)),
  (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return next(new (require('../utils/response').AppError)('id 必须是数字', 'VALIDATION_ERROR', 400));
      }
      const ann = svc.getAnnouncementById(id, req.user);
      success(res, ann);
    } catch (err) { next(err); }
  }
);

module.exports = router;
