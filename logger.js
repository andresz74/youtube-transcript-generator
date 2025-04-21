const winston = require('winston');

// Create a logger with a simple configuration
const logger = winston.createLogger({
  level: 'info',  // Log level (adjust as needed)
  format: winston.format.simple(),
  transports: [
    new winston.transports.Console(),  // Logs to the console
    new winston.transports.File({ filename: 'logs/endpoint.log' })  // Logs to a file (optional)
  ]
});

module.exports = logger;
