const { getDb } = require('../db');
const { AppError } = require('../utils/response');

function auth(req, _res, next) {
  const userId = req.header('X-User-Id');
  if (!userId) {
    return next(new AppError('缺少认证信息，请提供 X-User-Id 请求头', 'AUTH_REQUIRED', 401));
  }
  const id = parseInt(userId, 10);
  if (isNaN(id)) {
    return next(new AppError('X-User-Id 必须为数字', 'INVALID_AUTH', 401));
  }
  const db = getDb();
  const user = db.prepare('SELECT id, username, name, role FROM users WHERE id = ?').get(id);
  if (!user) {
    return next(new AppError('用户不存在', 'USER_NOT_FOUND', 401));
  }
  req.user = user;
  next();
}

function requireRole(...allowedRoles) {
  return (req, _res, next) => {
    if (!req.user) {
      return next(new AppError('未登录', 'AUTH_REQUIRED', 401));
    }
    if (!allowedRoles.includes(req.user.role)) {
      return next(
        new AppError(
          `权限不足，需要角色: ${allowedRoles.join('/')}，当前角色: ${req.user.role}`,
          'PERMISSION_DENIED',
          403,
          { allowedRoles, currentRole: req.user.role }
        )
      );
    }
    next();
  };
}

module.exports = { auth, requireRole };
