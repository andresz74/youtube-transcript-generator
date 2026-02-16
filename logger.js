const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',  // Adjust log level as needed
  format: winston.format.simple(),
  transports: [
    new winston.transports.Console(),  // Log to stdout
    new winston.transports.File({ filename: 'logs/endpoint.log' })  // Optional file logging
  ],
});

module.exports = logger;
