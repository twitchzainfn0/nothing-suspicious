const { spawn } = require('child_process');
require('dotenv').config();

console.log('Starting Roblox Anti-Leak System...');

// Verify required environment variables
const requiredEnvVars = ['DISCORD_TOKEN', 'BOT_OWNER_ID'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
    console.error('❌ Missing required environment variables:', missingVars);
    console.error('Please check your .env file and ensure all required variables are set.');
    process.exit(1);
}

console.log('✅ Environment variables verified');

// Start the API server first
console.log('🚀 Starting API server...');
const server = spawn('node', ['server.js'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env }
});

server.stdout.on('data', (data) => {
    process.stdout.write(`[SERVER] ${data}`);
});

server.stderr.on('data', (data) => {
    process.stderr.write(`[SERVER] ${data}`);
});

let botProcess = null;

// Wait for server to be ready before starting bot
setTimeout(() => {
    console.log('🤖 Starting Discord bot...');
    botProcess = spawn('node', ['bot.js'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
    });

    botProcess.stdout.on('data', (data) => {
        process.stdout.write(`[BOT] ${data}`);
    });

    botProcess.stderr.on('data', (data) => {
        process.stderr.write(`[BOT] ${data}`);
    });

    botProcess.on('close', (code) => {
        console.log(`Discord bot exited with code ${code}`);
        if (code !== 0 && code !== null) {
            console.error('Bot crashed, shutting down server...');
            server.kill('SIGTERM');
            process.exit(code);
        }
    });

    botProcess.on('error', (err) => {
        console.error('Bot process error:', err);
        server.kill('SIGTERM');
        process.exit(1);
    });
}, 3000); // Increased wait time

// Handle graceful shutdown
function gracefulShutdown(signal) {
    console.log(`\n📴 Received ${signal}, shutting down gracefully...`);
    
    if (botProcess) {
        console.log('Stopping Discord bot...');
        botProcess.kill('SIGTERM');
    }
    
    console.log('Stopping API server...');
    server.kill('SIGTERM');
    
    setTimeout(() => {
        console.log('Force killing processes...');
        if (botProcess) botProcess.kill('SIGKILL');
        server.kill('SIGKILL');
        process.exit(0);
    }, 5000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

server.on('close', (code) => {
    console.log(`API server exited with code ${code}`);
    if (botProcess) {
        botProcess.kill('SIGTERM');
    }
    process.exit(code || 0);
});

server.on('error', (err) => {
    console.error('Server process error:', err);
    if (botProcess) {
        botProcess.kill('SIGTERM');
    }
    process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    gracefulShutdown('UNHANDLED_REJECTION');
});