const { WebSocketServer } = require('ws');
const url = require('url');
const config = require('../config');
const logger = require('../utils/logger');
const printerService = require('./printer-pdf-pkd');

// Helper function to send standardized messages to a client
const sendMessage = (ws, event, data = {}, requestId = null) => {
  const payload = JSON.stringify({ event, data, requestId });
  if (ws.readyState === 1) { // 1 === OPEN
    ws.send(payload);
  }
};

const handleMessage = async (ws, message) => {
  try {
    // payload: { printerName, type, source, contentType, copies }
    const { event, payload, requestId } = JSON.parse(message);
    logger.debug(`WebSocket message received: Event='${event}', RequestID='${requestId}'`);

    switch (event) {
      case 'listPrinters': {
        const printers = printerService.getPrinters();
        sendMessage(ws, 'printersList', printers, requestId);
        break;
      }
      
      case 'printJob': {
        // Acknowledge that the job has been received
        sendMessage(ws, 'jobStatus', { status: 'received', message: 'Print job received and is being processed.' }, requestId);
        
        try {
          const result = await printerService.addJobToQueue(payload);
          // Send success status
          sendMessage(ws, 'jobStatus', { status: 'success', message: 'Print job completed successfully.', details: result }, requestId);
        } catch (error) {
          // Send failure status
          logger.error(`WebSocket Print Job Failed: ${error.message}`);
          sendMessage(ws, 'jobStatus', { status: 'error', message: error.message || 'An unknown error occurred during printing.' }, requestId);
        }
        break;
      }

      default:
        sendMessage(ws, 'error', { message: `Unknown event type: '${event}'` }, requestId);
        logger.warn(`Received unknown WebSocket event: ${event}`);
    }
  } catch (error) {
    sendMessage(ws, 'error', { message: 'Invalid message format. Messages must be valid JSON.' });
    logger.error(`Error processing WebSocket message: ${error.message}`);
  }
};

const initializeWebSocketServer = (httpServer) => {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    // 1. Authenticate the connection
    const { query } = url.parse(request.url, true);
    const origin = request.headers.origin;

    // Check allowed origin
    if (origin !== config.security.allowedOrigin) {
      logger.warn(`WebSocket connection rejected from invalid origin: ${origin}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // Check API key if enabled
    if (config.security.apiKey && query.apiKey !== config.security.apiKey) {
      logger.warn('WebSocket connection rejected due to invalid or missing API key.');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // 2. If authenticated, upgrade the connection
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws) => {
    logger.info('WebSocket client connected.');
    
    sendMessage(ws, 'connected', { message: 'Successfully connected to LIMS Print Service.' });

    ws.on('message', (message) => handleMessage(ws, message));

    ws.on('close', () => {
      logger.info('WebSocket client disconnected.');
    });

    ws.on('error', (error) => {
      logger.error('WebSocket error:', error);
    });
  });

  logger.info('🚀 WebSocket server initialized and attached.');
};

module.exports = initializeWebSocketServer;