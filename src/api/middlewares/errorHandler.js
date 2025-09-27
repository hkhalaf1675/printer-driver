const logger = require('../../utils/logger');

const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  
  logger.error(err.message, { 
    stack: err.stack,
    statusCode: statusCode,
    path: req.originalUrl 
  });

  res.status(statusCode).json({
    status: 'error',
    statusCode: statusCode,
    message: err.message || 'An unexpected internal server error occurred.',
  });
};

module.exports = errorHandler;