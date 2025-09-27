const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const config = require('./config');
const logger = require('./utils/logger');
const routes = require('./api/routes');
const errorHandler = require('./api/middlewares/errorHandler');
const { apiKeyAuth } = require('./api/middlewares/security');
const createError = require('http-errors');

const app = express();

// Security and CORS Middleware
app.use(helmet());
app.use(cors({ origin: config.security.allowedOrigin }));

// Request Logging
const morganStream = {
  write: (message) => logger.http(message.trim()),
};
app.use(morgan('tiny', { stream: morganStream }));

// Body Parsing
app.use(express.json({ limit: '10mb' })); // Support larger base64 payloads
// app.use(express.urlencoded({ extended: true }));

// Security Middleware (API Key and Localhost check)
app.use(apiKeyAuth);

// API Routes
app.use('/', routes);

// 404 Not Found Handler
app.use((req, res, next) => {
  next(createError(404, 'The requested resource was not found.'));
});

// Centralized Error Handler
app.use(errorHandler);

module.exports = app;