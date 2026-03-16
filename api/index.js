// Load environment variables
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// Import app with error catching
let app;
try {
  app = require('../src/app');
} catch (err) {
  console.error('FATAL: app failed to load:', err.message, err.stack);
  // Return a minimal handler that shows the error
  app = (req, res) => {
    res.status(500).json({
      error: 'App failed to load',
      message: err.message,
      stack: err.stack.split('\n').slice(0, 10)
    });
  };
}

// Export for Vercel
module.exports = app;
