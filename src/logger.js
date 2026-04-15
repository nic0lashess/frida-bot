const pino = require('pino');
const { logLevel } = require('./config');

module.exports = pino({
  level: logLevel,
  transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
});
