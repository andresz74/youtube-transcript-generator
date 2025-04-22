const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',  // Adjust log level as needed
  format: winston.format.simple(),
  transports: [
    new winston.transports.Console(),  // Log to the console (stdout)
    new winston.transports.Stream({
      stream: process.stdout,  // Ensures logs are written to stdout, which systemd can capture
    }),
    new winston.transports.File({ filename: 'logs/endpoint.log' })  // Optional file logging
  ],
});

module.exports = logger;
