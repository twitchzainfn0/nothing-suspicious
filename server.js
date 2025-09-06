require('dotenv').config();
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const APPROVED_USERS_FILE = path.join(__dirname, 'approved_users.txt');
const LICENSES_DIR = path.join(__dirname, 'licenses');

// Ensure required environment variables are set
if (!process.env.ADMIN_KEY) {
  console.warn('⚠️  ADMIN_KEY environment variable is not set. Using default (insecure for production!)');
  process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'Zu1qurn@1n';
}

// Rate limiting to prevent spam
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'production' ? 200 : 100, // Higher limit in production
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);
app.use(express.json());

// Add CORS middleware for web compatibility
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Function to read approved users from file
async function getApprovedUsers() {
  try {
    const data = await fs.readFile(APPROVED_USERS_FILE, 'utf8');
    return data.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#')); // Remove empty lines and comments
  } catch (error) {
    console.error('Error reading approved users file:', error);
    return [];
  }
}

// Function to read users for a specific license
async function getUsersForLicense(licenseKey) {
  try {
    // Sanitize license key to prevent directory traversal
    const sanitizedLicenseKey = licenseKey.replace(/[^a-zA-Z0-9_-]/g, '');
    const licenseFile = path.join(LICENSES_DIR, `${sanitizedLicenseKey}.txt`);
    
    const data = await fs.readFile(licenseFile, 'utf8');
    return data.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  } catch (error) {
    // Don't log error if file doesn't exist (normal case)
    if (error.code !== 'ENOENT') {
      console.error(`Error reading license file for ${licenseKey}:`, error);
    }
    return [];
  }
}

// Function to add user to approved list
async function addApprovedUser(username) {
  try {
    const approvedUsers = await getApprovedUsers();
    if (!approvedUsers.includes(username)) {
      await fs.appendFile(APPROVED_USERS_FILE, `\n${username}`);
      return true;
    }
    return false; // User already exists
  } catch (error) {
    console.error('Error adding user:', error);
    return false;
  }
}

// Function to remove user from approved list
async function removeApprovedUser(username) {
  try {
    const approvedUsers = await getApprovedUsers();
    const updatedUsers = approvedUsers.filter(user => user !== username);
    
    if (updatedUsers.length !== approvedUsers.length) {
      await fs.writeFile(APPROVED_USERS_FILE, updatedUsers.join('\n'));
      return true;
    }
    return false; // User not found
  } catch (error) {
    console.error('Error removing user:', error);
    return false;
  }
}

// Main endpoint for license-based user checking
app.get('/check-user-license/:licenseKey/:username', async (req, res) => {
  const { licenseKey, username } = req.params;
  
  if (!licenseKey || !username) {
    return res.status(400).json({ error: 'License key and username are required' });
  }
  
  try {
    const approvedUsers = await getUsersForLicense(licenseKey);
    const isApproved = approvedUsers.includes(username);
    
    res.json({
      username,
      licenseKey,
      approved: isApproved,
      timestamp: new Date().toISOString()
    });
    
    // Log the check for monitoring
    console.log(`License check: ${licenseKey} - ${username} - ${isApproved ? 'APPROVED' : 'DENIED'}`);
    
  } catch (error) {
    console.error('Error checking user with license:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Original endpoint for backwards compatibility
app.get('/check-user/:username', async (req, res) => {
  const { username } = req.params;
  
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }
  
  try {
    const approvedUsers = await getApprovedUsers();
    const isApproved = approvedUsers.includes(username);
    
    res.json({
      username,
      approved: isApproved,
      timestamp: new Date().toISOString()
    });
    
    // Log the check for monitoring
    console.log(`User check: ${username} - ${isApproved ? 'APPROVED' : 'DENIED'}`);
    
  } catch (error) {
    console.error('Error checking user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin endpoint to add user
app.post('/admin/add-user', async (req, res) => {
  const { username, adminKey } = req.body;
  
  // Simple admin key check
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }
  
  const success = await addApprovedUser(username);
  
  if (success) {
    res.json({ message: `User ${username} added successfully` });
  } else {
    res.status(400).json({ error: 'User already exists or error occurred' });
  }
});

// Admin endpoint to remove user
app.post('/admin/remove-user', async (req, res) => {
  const { username, adminKey } = req.body;
  
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }
  
  const success = await removeApprovedUser(username);
  
  if (success) {
    res.json({ message: `User ${username} removed successfully` });
  } else {
    res.status(400).json({ error: 'User not found or error occurred' });
  }
});

// Endpoint to list all approved users (admin only)
app.get('/admin/users', async (req, res) => {
  const { adminKey } = req.query;
  
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const approvedUsers = await getApprovedUsers();
  res.json({ users: approvedUsers, count: approvedUsers.length });
});

// Endpoint to list users for a specific license
app.get('/admin/license-users/:licenseKey', async (req, res) => {
  const { licenseKey } = req.params;
  const { adminKey } = req.query;
  
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const licenseUsers = await getUsersForLicense(licenseKey);
  res.json({ 
    licenseKey, 
    users: licenseUsers, 
    count: licenseUsers.length 
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Roblox Anti-Leak API',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      checkUser: '/check-user/:username',
      checkUserLicense: '/check-user-license/:licenseKey/:username'
    }
  });
});

// Initialize approved users file if it doesn't exist
async function initializeUsersFile() {
  try {
    await fs.access(APPROVED_USERS_FILE);
  } catch {
    // File doesn't exist, create it with a comment
    const initialContent = `# Approved Users List
# Add one username per line
# Lines starting with # are comments and will be ignored
# Example:
# YourUsername
# AnotherUser`;
    await fs.writeFile(APPROVED_USERS_FILE, initialContent);
    console.log('Created approved_users.txt file');
  }
}

// Initialize licenses directory
async function initializeLicensesDir() {
  try {
    await fs.access(LICENSES_DIR);
  } catch {
    await fs.mkdir(LICENSES_DIR, { recursive: true });
    console.log('Created licenses directory');
  }
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
app.listen(PORT, async () => {
  await initializeUsersFile();
  await initializeLicensesDir();
  console.log(`✅ Anti-leak API server running on port ${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  console.log(`🔗 License endpoint: http://localhost:${PORT}/check-user-license/{licenseKey}/{username}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;