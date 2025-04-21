const winston = require('winston');
const { transports } = require('winston');

// Create a logger with a configuration for the system journal
const logger = winston.createLogger({
  level: 'info',  // Adjust log level
  format: winston.format.simple(),
  transports: [
    new transports.Console(),  // Log to console
    new transports.File({ filename: 'logs/endpoint.log' }),  // Optionally, log to a file
    new transports.Stream({
      stream: process.stdout,  // Optionally log to stdout (useful in Cockpit)
    }),
    new transports.Http({
      host: 'localhost',
      port: 514,  // For syslog integration (optional)
      path: '/logs',  // Optional path if using HTTP endpoint for logs
    }),
  ],
});

module.exports = logger;
