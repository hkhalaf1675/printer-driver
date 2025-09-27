const dotenv = require('dotenv');
const yaml = require('yaml');
const fs = require('fs');
const path = require('path');

dotenv.config();

// Load YAML config
const yamlConfigPath = path.join(process.cwd(), 'config.yaml');
const yamlFile = fs.readFileSync(yamlConfigPath, 'utf8');
const yamlConfig = yaml.parse(yamlFile);

const config = {
  server: {
    port: process.env.PORT || 9100,
    host: process.env.HOST || '127.0.0.1',
  },
  security: {
    apiKey: process.env.API_KEY || null,
    allowedOrigin: process.env.ALLOWED_ORIGIN || `http://localhost:${process.env.PORT}`,
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
  printer: {
    defaults: yamlConfig.defaults,
  },
};

module.exports = config;