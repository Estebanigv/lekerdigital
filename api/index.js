// Load environment variables
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// Import app
const app = require('../src/app');

// Export for Vercel
module.exports = app;
