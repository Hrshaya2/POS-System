// Vercel Serverless Entry Point
// This imports the Express app from the main index.js
// and exports it as a Vercel serverless function
const app = require('../index');

module.exports = app;