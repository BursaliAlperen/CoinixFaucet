const logger = {
  info: (msg, meta = {}) => {
    console.log(JSON.stringify({ level: 'info', message: msg, timestamp: new Date().toISOString(), ...meta }));
  },
  error: (msg, meta = {}) => {
    console.error(JSON.stringify({ level: 'error', message: msg, timestamp: new Date().toISOString(), ...meta }));
  },
  warn: (msg, meta = {}) => {
    console.warn(JSON.stringify({ level: 'warn', message: msg, timestamp: new Date().toISOString(), ...meta }));
  },
  debug: (msg, meta = {}) => {
    if (process.env.NODE_ENV !== 'production') {
      console.log(JSON.stringify({ level: 'debug', message: msg, timestamp: new Date().toISOString(), ...meta }));
    }
  }
};

module.exports = logger;
