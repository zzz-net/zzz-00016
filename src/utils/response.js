class AppError extends Error {
  constructor(message, code = 'INTERNAL_ERROR', status = 500, details = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function success(res, data = null, message = 'ok') {
  return res.json({
    success: true,
    code: 'OK',
    message,
    data,
    timestamp: new Date().toISOString()
  });
}

function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      success: false,
      code: err.code,
      message: err.message,
      details: err.details,
      timestamp: new Date().toISOString()
    });
  }
  console.error('[Unhandled Error]', err);
  return res.status(500).json({
    success: false,
    code: 'INTERNAL_ERROR',
    message: '服务器内部错误',
    details: process.env.NODE_ENV === 'development' ? err.message : null,
    timestamp: new Date().toISOString()
  });
}

function notFoundHandler(req, res) {
  return res.status(404).json({
    success: false,
    code: 'NOT_FOUND',
    message: `接口不存在: ${req.method} ${req.path}`,
    timestamp: new Date().toISOString()
  });
}

module.exports = { AppError, success, errorHandler, notFoundHandler };
