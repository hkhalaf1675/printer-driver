const createError = require('http-errors');
const config = require('../../config');
const logger = require('../../utils/logger');

const apiKeyAuth = (req, res, next) => {
  // Enforce localhost access
  const clientIp = req.ip;
  const isLocalhost = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(clientIp);

  if (!isLocalhost) {
    logger.warn(`Rejected request from non-localhost IP: ${clientIp}`);
    return next(createError(403, 'Access denied. Requests are only allowed from localhost.'));
  }
  
  // Check for API key if it's configured
  if (config.security.apiKey) {
    const providedKey = req.get('X-API-KEY');
    if (!providedKey || providedKey !== config.security.apiKey) {
      logger.warn(`Rejected request with invalid or missing API key from IP: ${clientIp}`);
      return next(createError(401, 'Unauthorized: Invalid API key.'));
    }
  }

  next();
};

module.exports = { apiKeyAuth };