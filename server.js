require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL connection pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

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

// Function to check if a user is authorized for a specific license
async function checkUserLicense(licenseKey, username) {
  try {
    const result = await pool.query(
      `SELECT 
        CASE 
          WHEN EXISTS (
            SELECT 1 FROM authorized_users 
            WHERE license_key = $1 AND username = $2 AND vehicle = '*ALL*'
          ) THEN true
          WHEN EXISTS (
            SELECT 1 FROM authorized_users 
            WHERE license_key = $1 AND username = $2
          ) THEN true
          ELSE false
        END as is_authorized`,
      [licenseKey, username]
    );
    
    return result.rows[0].is_authorized;
  } catch (error) {
    console.error('Error checking user license:', error);
    return false;
  }
}

// Function to get all users for a specific license
async function getUsersForLicense(licenseKey) {
  try {
    const result = await pool.query(
      'SELECT username, vehicle FROM authorized_users WHERE license_key = $1',
      [licenseKey]
    );
    return result.rows;
  } catch (error) {
    console.error('Error getting users for license:', error);
    return [];
  }
}

// Function to add user to a license
async function addUserToLicense(licenseKey, username, vehicle = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const actualVehicle = vehicle === null ? '*ALL*' : vehicle;
    
    // Check if user already exists with this vehicle
    const existingCheck = await client.query(
      'SELECT id FROM authorized_users WHERE license_key = $1 AND username = $2 AND vehicle = $3',
      [licenseKey, username, actualVehicle]
    );
    
    if (existingCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return false; // User already exists with this vehicle
    }
    
    // If adding all vehicles, remove any specific vehicle entries
    if (actualVehicle === '*ALL*') {
      await client.query(
        'DELETE FROM authorized_users WHERE license_key = $1 AND username = $2',
        [licenseKey, username]
      );
    }
    
    // Add the new authorization
    await client.query(
      'INSERT INTO authorized_users (license_key, username, vehicle) VALUES ($1, $2, $3)',
      [licenseKey, username, actualVehicle]
    );
    
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error adding user to license:', error);
    return false;
  } finally {
    client.release();
  }
}

// Function to remove user from a license
async function removeUserFromLicense(licenseKey, username, vehicle = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    let result;
    if (vehicle) {
      result = await client.query(
        'DELETE FROM authorized_users WHERE license_key = $1 AND username = $2 AND vehicle = $3',
        [licenseKey, username, vehicle]
      );
    } else {
      result = await client.query(
        'DELETE FROM authorized_users WHERE license_key = $1 AND username = $2',
        [licenseKey, username]
      );
    }
    
    await client.query('COMMIT');
    return result.rowCount > 0;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error removing user from license:', error);
    return false;
  } finally {
    client.release();
  }
}

// Main endpoint for license-based user checking
app.get('/check-user-license/:licenseKey/:username', async (req, res) => {
  const { licenseKey, username } = req.params;
  
  if (!licenseKey || !username) {
    return res.status(400).json({ error: 'License key and username are required' });
  }
  
  try {
    const isApproved = await checkUserLicense(licenseKey, username);
    
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

// Admin endpoint to add user to a license
app.post('/admin/add-user-license', async (req, res) => {
  const { licenseKey, username, vehicle, adminKey } = req.body;
  
  // Simple admin key check
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (!licenseKey || !username) {
    return res.status(400).json({ error: 'License key and username are required' });
  }
  
  const success = await addUserToLicense(licenseKey, username, vehicle);
  
  if (success) {
    res.json({ message: `User ${username} added to license ${licenseKey} successfully` });
  } else {
    res.status(400).json({ error: 'User already exists or error occurred' });
  }
});

// Admin endpoint to remove user from a license
app.post('/admin/remove-user-license', async (req, res) => {
  const { licenseKey, username, vehicle, adminKey } = req.body;
  
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (!licenseKey || !username) {
    return res.status(400).json({ error: 'License key and username are required' });
  }
  
  const success = await removeUserFromLicense(licenseKey, username, vehicle);
  
  if (success) {
    res.json({ message: `User ${username} removed from license ${licenseKey} successfully` });
  } else {
    res.status(400).json({ error: 'User not found or error occurred' });
  }
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
app.get('/health', async (req, res) => {
  try {
    // Test database connection
    await pool.query('SELECT 1');
    res.json({ 
      status: 'OK', 
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      database: 'Connected'
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'ERROR', 
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      database: 'Disconnected',
      error: error.message
    });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Roblox Anti-Leak API',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      checkUserLicense: '/check-user-license/:licenseKey/:username'
    }
  });
});

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
app.listen(PORT, () => {
  console.log(`✅ Anti-leak API server running on port ${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  console.log(`🔗 License endpoint: http://localhost:${PORT}/check-user-license/{licenseKey}/{username}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
