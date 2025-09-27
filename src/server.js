const app = require('./app');
const config = require('./config');
const initializeWebSocketServer = require('./services/websocketService');
const logger = require('./utils/logger');

const server = app.listen(config.server.port, config.server.host, () => {
  logger.info(`🖨️  LIMS Print Service is running on http://${config.server.host}:${config.server.port}`);
  logger.info(`🔒 API Key authentication is ${config.security.apiKey ? 'ENABLED' : 'DISABLED'}.`);
  logger.info(`🌐 Accepting requests from origin: ${config.security.allowedOrigin}`);
});

initializeWebSocketServer(server);

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception thrown:', error);
  process.exit(1);
});