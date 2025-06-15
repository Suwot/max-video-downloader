/**
 * Enhanced logging utility with automatic stack trace capture
 * 
 * Features:
 * - Automatic caller detection
 * - Timestamp inclusion
 * - Configurable log levels
 * - Group logging support
 * - Module/context tagging
 */

// Configure log level for different environments
const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  NONE: 4
};

// Default runtime configuration
const config = {
  currentLevel: LOG_LEVELS.DEBUG, // Can be changed at runtime
  showTimestamp: true,
  showCaller: true
};

/**
 * Get caller information from stack trace
 * @returns {string} Formatted caller info
 */
function getCallerInfo() {
  const stack = new Error().stack.split('\n');
  // We need to go deeper in the stack to find the actual caller
  // 0=Error, 1=getCallerInfo, 2=log function, 3=logger method (debug/info/etc), 4=actual caller
  const callerLine = stack[4] ? stack[4].trim() : 'unknown';
  
  // Extract just the function name and line number for cleaner output
  const callerMatch = callerLine.match(/at\s+([^\s]+)\s+\((.+?):(\d+):(\d+)\)/);
  if (callerMatch) {
    const [_, funcName, filePath, line] = callerMatch;
    const fileName = filePath.split('/').pop();
    return `${funcName}(${fileName}:${line})`;
  }
  
  // Handle anonymous functions or other stack trace formats
  const simpleMatch = callerLine.match(/at\s+(.+?):(\d+):(\d+)/);
  if (simpleMatch) {
    const [_, filePath, line, col] = simpleMatch;
    const fileName = filePath.split('/').pop();
    return `${fileName}:${line}`;
  }
  
  // Fallback for when regex doesn't match
  return callerLine.replace(/^\s*at\s+/, '');
}

/**
 * Core logging function with support for different log levels
 * @param {string} level - Log level (debug, info, warn, error, group)
 * @param {string} module - Module name or context where log originated
 * @param {...any} args - Arguments to log
 */
function log(level = 'debug', module, ...args) {
  // Check if we should log based on current level
  const levelValue = level === 'group' ? LOG_LEVELS.DEBUG : LOG_LEVELS[level.toUpperCase()] || 0;
  if (levelValue < config.currentLevel) return;
  
  // Build log prefix
  const timestamp = config.showTimestamp ? new Date().toISOString() : '';
  const caller = config.showCaller ? getCallerInfo() : '';
  const prefix = `[${module}]`;
  
  // Format prefix components
  const prefixParts = [prefix];
  if (timestamp) prefixParts.push(timestamp);
  if (caller) prefixParts.push(`<${caller}>`);
  
  const formattedPrefix = prefixParts.join(' ');
  
  // Log based on level
  switch(level) {
    case 'error':
      console.error(formattedPrefix, ...args);
      break;
    case 'warn':
      console.warn(formattedPrefix, ...args);
      break;
    case 'group':
      console.group(`${formattedPrefix} - ${args[0] || ''}`);
      args.slice(1).forEach(arg => console.log(arg));
      console.groupEnd();
      break;
    case 'info':
      console.info(formattedPrefix, ...args);
      break;
    case 'debug':
    default:
      console.log(formattedPrefix, ...args);
  }
}

/**
 * Create a logger instance for a specific module
 * @param {string} moduleName - Name of the module for log prefix
 * @returns {Object} Logger methods
 */
function createLogger(moduleName) {
  return {
    debug: (...args) => log('debug', moduleName, ...args),
    info: (...args) => log('info', moduleName, ...args),
    warn: (...args) => log('warn', moduleName, ...args),
    error: (...args) => log('error', moduleName, ...args),
    group: (...args) => log('group', moduleName, ...args),
    
    // Allow changing config for this logger
    setLevel: (level) => {
      if (LOG_LEVELS[level.toUpperCase()] !== undefined) {
        config.currentLevel = LOG_LEVELS[level.toUpperCase()];
      }
    }
  };
}

// Export logger utilities
export { 
  createLogger,
  LOG_LEVELS
};