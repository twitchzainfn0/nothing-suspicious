const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { Pool } = require('pg');
const logger = require('./logger');
require('dotenv').config();

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages]
});

// PostgreSQL connection pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Special value for "all vehicles" authorization
const ALL_VEHICLES = '*ALL*';

// Role types for license management
const ROLE_TYPES = {
    ADMIN: 'admin',
    HELPER: 'helper'
};

// Initialize database tables
async function initializeDatabase() {
    try {
        // Create licenses table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS licenses (
                license_key VARCHAR(255) PRIMARY KEY,
                owner_id VARCHAR(255) NOT NULL,
                owner_tag VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // Create authorized_users table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS authorized_users (
                id SERIAL PRIMARY KEY,
                license_key VARCHAR(255) REFERENCES licenses(license_key) ON DELETE CASCADE,
                username VARCHAR(255) NOT NULL,
                vehicle VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(license_key, username, vehicle)
            )
        `);

        // Create paused_licenses table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS paused_licenses (
                license_key VARCHAR(255) PRIMARY KEY REFERENCES licenses(license_key) ON DELETE CASCADE,
                owner_id VARCHAR(255) NOT NULL,
                owner_tag VARCHAR(255) NOT NULL,
                paused_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // Create license_admins table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS license_admins (
                id SERIAL PRIMARY KEY,
                license_key VARCHAR(255) REFERENCES licenses(license_key) ON DELETE CASCADE,
                user_id VARCHAR(255) NOT NULL,
                user_tag VARCHAR(255) NOT NULL,
                role_type VARCHAR(50) NOT NULL,
                added_by VARCHAR(255) NOT NULL,
                added_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(license_key, user_id)
            )
        `);

        logger.info('Database tables initialized');
    } catch (error) {
        logger.error('Error initializing database:', error);
        throw error;
    }
}

// License management functions
async function getLicenses() {
    try {
        const result = await pool.query('SELECT * FROM licenses');
        const licenses = {};
        result.rows.forEach(row => {
            licenses[row.license_key] = {
                ownerId: row.owner_id,
                ownerTag: row.owner_tag,
                createdAt: row.created_at
            };
        });
        return licenses;
    } catch (error) {
        logger.error('Error reading licenses:', error);
        return {};
    }
}

async function createLicense(licenseKey, ownerId, ownerTag) {
    try {
        await pool.query(
            'INSERT INTO licenses (license_key, owner_id, owner_tag) VALUES ($1, $2, $3)',
            [licenseKey, ownerId, ownerTag]
        );
        return true;
    } catch (error) {
        logger.error('Error creating license:', error);
        return false;
    }
}

async function deleteLicense(licenseKey) {
    try {
        await pool.query('DELETE FROM licenses WHERE license_key = $1', [licenseKey]);
        return true;
    } catch (error) {
        logger.error('Error deleting license:', error);
        return false;
    }
}

async function getUsersForLicense(licenseKey) {
    try {
        const result = await pool.query(
            'SELECT username, vehicle FROM authorized_users WHERE license_key = $1',
            [licenseKey]
        );
        return result.rows;
    } catch (error) {
        logger.warn(`No users found for license ${licenseKey}:`, error);
        return [];
    }
}

async function addUserToLicense(licenseKey, username, vehicle = null) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const actualVehicle = vehicle === null ? ALL_VEHICLES : vehicle;
        
        // Check if user already has access to all vehicles
        const allAccessCheck = await client.query(
            'SELECT id FROM authorized_users WHERE license_key = $1 AND username = $2 AND vehicle = $3',
            [licenseKey, username, ALL_VEHICLES]
        );
        
        if (allAccessCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            logger.warn(`User ${username} already has access to ALL vehicles in license ${licenseKey}`);
            return { success: false, message: 'User already has access to all vehicles' };
        }
        
        // Check if user already has this specific vehicle
        const specificCheck = await client.query(
            'SELECT id FROM authorized_users WHERE license_key = $1 AND username = $2 AND vehicle = $3',
            [licenseKey, username, actualVehicle]
        );
        
        if (specificCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            logger.warn(`User ${username} already has vehicle ${actualVehicle} in license ${licenseKey}`);
            return { success: false, message: 'User already has this vehicle' };
        }
        
        // Add the new authorization
        await client.query(
            'INSERT INTO authorized_users (license_key, username, vehicle) VALUES ($1, $2, $3)',
            [licenseKey, username, actualVehicle]
        );
        
        await client.query('COMMIT');
        
        logger.info(`Added user ${username} with vehicle ${actualVehicle} to license ${licenseKey}`);
        return { success: true, forAllVehicles: actualVehicle === ALL_VEHICLES };
    } catch (error) {
        await client.query('ROLLBACK');
        logger.error('Error adding user to license:', error);
        return { success: false, message: 'Error adding user' };
    } finally {
        client.release();
    }
}

async function removeUserFromLicense(licenseKey, username, vehicle = null) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        let result;
        if (vehicle) {
            // Remove specific vehicle for user
            result = await client.query(
                'DELETE FROM authorized_users WHERE license_key = $1 AND username = $2 AND vehicle = $3',
                [licenseKey, username, vehicle]
            );
            
            if (result.rowCount === 0) {
                await client.query('ROLLBACK');
                logger.warn(`Vehicle ${vehicle} not found for user ${username} in license ${licenseKey}`);
                return false;
            }
            
            logger.info(`Removed vehicle ${vehicle} from user ${username} in license ${licenseKey}`);
        } else {
            // Remove ALL authorization for user
            result = await client.query(
                'DELETE FROM authorized_users WHERE license_key = $1 AND username = $2',
                [licenseKey, username]
            );
            
            if (result.rowCount === 0) {
                await client.query('ROLLBACK');
                logger.warn(`User ${username} not found in license ${licenseKey}`);
                return false;
            }
            
            logger.info(`Removed ALL vehicles for user ${username} from license ${licenseKey}`);
        }
        
        await client.query('COMMIT');
        return true;
    } catch (error) {
        await client.query('ROLLBACK');
        logger.error('Error removing user from license:', error);
        return false;
    } finally {
        client.release();
    }
}

// Pause license functions
async function pauseLicense(licenseKey, ownerId, ownerTag) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Check if license exists
        const licenseCheck = await client.query(
            'SELECT license_key FROM licenses WHERE license_key = $1',
            [licenseKey]
        );
        
        if (licenseCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return { success: false, message: 'License not found' };
        }
        
        // Check if already paused
        const pauseCheck = await client.query(
            'SELECT license_key FROM paused_licenses WHERE license_key = $1',
            [licenseKey]
        );
        
        if (pauseCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return { success: false, message: 'License is already paused' };
        }
        
        // Add to paused licenses
        await client.query(
            'INSERT INTO paused_licenses (license_key, owner_id, owner_tag) VALUES ($1, $2, $3)',
            [licenseKey, ownerId, ownerTag]
        );
        
        await client.query('COMMIT');
        logger.info(`License paused: ${licenseKey}`);
        return { success: true, message: 'License paused successfully' };
    } catch (error) {
        await client.query('ROLLBACK');
        logger.error('Error pausing license:', error);
        return { success: false, message: 'Error pausing license' };
    } finally {
        client.release();
    }
}

async function unpauseLicense(licenseKey) {
    try {
        const result = await pool.query(
            'DELETE FROM paused_licenses WHERE license_key = $1',
            [licenseKey]
        );
        
        if (result.rowCount === 0) {
            return { success: false, message: 'License is not paused or does not exist' };
        }
        
        logger.info(`License unpaused: ${licenseKey}`);
        return { success: true, message: 'License unpaused successfully' };
    } catch (error) {
        logger.error('Error unpausing license:', error);
        return { success: false, message: 'Error unpausing license' };
    }
}

async function isLicensePaused(licenseKey) {
    try {
        const result = await pool.query(
            'SELECT license_key FROM paused_licenses WHERE license_key = $1',
            [licenseKey]
        );
        return result.rows.length > 0;
    } catch (error) {
        logger.error('Error checking license pause status:', error);
        return false;
    }
}

// Utility function to get user's license key
async function getUserLicense(userId) {
    try {
        const result = await pool.query(
            'SELECT license_key FROM licenses WHERE owner_id = $1',
            [userId]
        );
        return result.rows.length > 0 ? result.rows[0].license_key : null;
    } catch (error) {
        logger.error('Error getting user license:', error);
        return null;
    }
}

// Function to get license info for a user
async function getLicenseInfo(userId) {
    try {
        // Get the license key
        const licenseResult = await pool.query(
            'SELECT license_key, owner_tag, created_at FROM licenses WHERE owner_id = $1',
            [userId]
        );
        
        if (licenseResult.rows.length === 0) {
            return null;
        }
        
        const license = licenseResult.rows[0];
        
        // Check if license is paused
        const isPaused = await isLicensePaused(license.license_key);
        
        // Get authorized users
        const authorizedUsers = await getUsersForLicense(license.license_key);
        
        // Group users with their vehicles
        const userVehicles = {};
        authorizedUsers.forEach(({ username, vehicle }) => {
            if (!userVehicles[username]) {
                userVehicles[username] = [];
            }
            userVehicles[username].push(vehicle === ALL_VEHICLES ? 'ALL Vehicles' : vehicle);
        });
        
        return {
            licenseKey: license.license_key,
            ownerTag: license.owner_tag,
            ownerId: userId,
            createdAt: license.created_at,
            isPaused: isPaused,
            authorizedUsers: userVehicles,
            totalUsers: Object.keys(userVehicles).length,
            totalAuthorizations: authorizedUsers.length
        };
    } catch (error) {
        logger.error('Error getting license info:', error);
        return null;
    }
}

// Admin/Helper management functions
async function addLicenseStaff(licenseKey, staffUserId, staffUserTag, roleType, addedByUserId) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Check if user is already staff for this license
        const existingCheck = await client.query(
            'SELECT id FROM license_admins WHERE license_key = $1 AND user_id = $2',
            [licenseKey, staffUserId]
        );
        
        if (existingCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return { success: false, message: 'User is already staff for this license' };
        }
        
        // Check if user is the license owner
        const ownerCheck = await client.query(
            'SELECT owner_id FROM licenses WHERE license_key = $1 AND owner_id = $2',
            [licenseKey, staffUserId]
        );
        
        if (ownerCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return { success: false, message: 'Cannot add license owner as staff' };
        }
        
        // Add the staff member
        await client.query(
            'INSERT INTO license_admins (license_key, user_id, user_tag, role_type, added_by) VALUES ($1, $2, $3, $4, $5)',
            [licenseKey, staffUserId, staffUserTag, roleType, addedByUserId]
        );
        
        await client.query('COMMIT');
        
        logger.info(`Added ${roleType} ${staffUserTag} to license ${licenseKey}`);
        return { success: true, message: `${roleType.charAt(0).toUpperCase() + roleType.slice(1)} added successfully` };
    } catch (error) {
        await client.query('ROLLBACK');
        logger.error('Error adding license staff:', error);
        return { success: false, message: 'Error adding staff member' };
    } finally {
        client.release();
    }
}

async function removeLicenseStaff(licenseKey, staffUserId, removedByUserId) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Remove the staff member
        const result = await client.query(
            'DELETE FROM license_admins WHERE license_key = $1 AND user_id = $2',
            [licenseKey, staffUserId]
        );
        
        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return { success: false, message: 'Staff member not found for this license' };
        }
        
        await client.query('COMMIT');
        
        logger.info(`Removed staff ${staffUserId} from license ${licenseKey}`);
        return { success: true, message: 'Staff member removed successfully' };
    } catch (error) {
        await client.query('ROLLBACK');
        logger.error('Error removing license staff:', error);
        return { success: false, message: 'Error removing staff member' };
    } finally {
        client.release();
    }
}

async function getLicenseStaff(licenseKey) {
    try {
        const result = await pool.query(
            'SELECT user_id, user_tag, role_type, added_by, added_at FROM license_admins WHERE license_key = $1 ORDER BY role_type, added_at',
            [licenseKey]
        );
        return result.rows;
    } catch (error) {
        logger.error('Error getting license staff:', error);
        return [];
    }
}

async function getUserStaffRoles(userId) {
    try {
        const result = await pool.query(
            `SELECT la.license_key, la.role_type, l.owner_tag 
             FROM license_admins la 
             JOIN licenses l ON la.license_key = l.license_key 
             WHERE la.user_id = $1`,
            [userId]
        );
        return result.rows;
    } catch (error) {
        logger.error('Error getting user staff roles:', error);
        return [];
    }
}

async function canUserManageLicense(userId, licenseKey, requireAdmin = false) {
    try {
        // Check if user is license owner
        const ownerCheck = await pool.query(
            'SELECT license_key FROM licenses WHERE license_key = $1 AND owner_id = $2',
            [licenseKey, userId]
        );
        
        if (ownerCheck.rows.length > 0) {
            return { canManage: true, isOwner: true, role: 'owner' };
        }
        
        // Check if user is staff for this license
        const staffCheck = await pool.query(
            'SELECT role_type FROM license_admins WHERE license_key = $1 AND user_id = $2',
            [licenseKey, userId]
        );
        
        if (staffCheck.rows.length > 0) {
            const staffRole = staffCheck.rows[0].role_type;
            if (requireAdmin && staffRole !== ROLE_TYPES.ADMIN) {
                return { canManage: false, isOwner: false, role: staffRole };
            }
            return { canManage: true, isOwner: false, role: staffRole };
        }
        
        return { canManage: false, isOwner: false, role: null };
    } catch (error) {
        logger.error('Error checking license management permissions:', error);
        return { canManage: false, isOwner: false, role: null };
    }
}

// NEW FUNCTION: Get all licenses with users and staff
async function getAllLicensesWithDetails() {
    try {
        // Get all licenses
        const licensesResult = await pool.query(`
            SELECT l.license_key, l.owner_id, l.owner_tag, l.created_at,
                   pl.paused_at IS NOT NULL as is_paused
            FROM licenses l
            LEFT JOIN paused_licenses pl ON l.license_key = pl.license_key
            ORDER BY l.created_at DESC
        `);
        
        const licenses = [];
        
        for (const license of licensesResult.rows) {
            // Get authorized users for this license
            const authorizedUsers = await getUsersForLicense(license.license_key);
            
            // Group users with their vehicles
            const userVehicles = {};
            authorizedUsers.forEach(({ username, vehicle }) => {
                if (!userVehicles[username]) {
                    userVehicles[username] = [];
                }
                userVehicles[username].push(vehicle === ALL_VEHICLES ? 'ALL Vehicles' : vehicle);
            });
            
            // Get staff for this license
            const staffMembers = await getLicenseStaff(license.license_key);
            
            licenses.push({
                licenseKey: license.license_key,
                ownerId: license.owner_id,
                ownerTag: license.owner_tag,
                createdAt: license.created_at,
                isPaused: license.is_paused,
                authorizedUsers: userVehicles,
                staffMembers: staffMembers,
                totalUsers: Object.keys(userVehicles).length,
                totalAuthorizations: authorizedUsers.length,
                totalStaff: staffMembers.length
            });
        }
        
        return licenses;
    } catch (error) {
        logger.error('Error getting all licenses with details:', error);
        return [];
    }
}

// Command definitions
const commands = [
    new SlashCommandBuilder()
        .setName('createlicense')
        .setDescription('Create a new license (Bot Owner Only)')
        .setDMPermission(true)
        .addUserOption(option => 
            option.setName('user')
                .setDescription('User who will own this license')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('licensekey')
                .setDescription('Custom license key (optional)')
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName('authorize')
        .setDescription('Add a user to approved list')
        .setDMPermission(true)
        .addStringOption(option =>
            option.setName('username')
                .setDescription('Roblox username to authorize')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('vehicle')
                .setDescription('Specific vehicle to authorize (leave empty for ALL vehicles)')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('licensekey')
                .setDescription('License key to manage (required if you have multiple staff roles)')
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName('deauthorize')
        .setDescription('Remove a user/vehicle from approved list')
        .setDMPermission(true)
        .addStringOption(option =>
            option.setName('username')
                .setDescription('Roblox username to deauthorize')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('vehicle')
                .setDescription('Specific vehicle to remove (leave empty to remove ALL authorization)')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('licensekey')
                .setDescription('License key to manage (required if you have multiple staff roles)')
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName('authorized')
        .setDescription('List all authorized users and their vehicles')
        .setDMPermission(true)
        .addStringOption(option =>
            option.setName('licensekey')
                .setDescription('License key to view (required if you have multiple staff roles)')
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName('mylicense')
        .setDescription('Show your license information')
        .setDMPermission(true),

    new SlashCommandBuilder()
        .setName('deletelicense')
        .setDescription('Delete a license (Bot Owner Only)')
        .setDMPermission(true)
        .addStringOption(option =>
            option.setName('licensekey')
                .setDescription('License key to delete')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('pauselicense')
        .setDescription('Pause a license (Bot Owner Only)')
        .setDMPermission(true)
        .addUserOption(option =>
            option.setName('user')
                .setDescription('User whose license to pause')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('unpauselicense')
        .setDescription('Unpause a license (Bot Owner Only)')
        .setDMPermission(true)
        .addUserOption(option =>
            option.setName('user')
                .setDescription('User whose license to unpause')
                .setRequired(true)),
                
    new SlashCommandBuilder()
        .setName('licenseinfo')
        .setDescription('Check license information for a user (Bot Owner Only)')
        .setDMPermission(true)
        .addUserOption(option =>
            option.setName('user')
                .setDescription('User to check license information for')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('transferlicense')
        .setDescription('Transfer a license from one user to another (Bot Owner Only)')
        .setDMPermission(true)
        .addUserOption(option =>
            option.setName('from')
                .setDescription('Current license owner')
                .setRequired(true))
        .addUserOption(option =>
            option.setName('to')
                .setDescription('New license owner')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('addstaff')
        .setDescription('Add an admin or helper to manage your license')
        .setDMPermission(true)
        .addUserOption(option =>
            option.setName('user')
                .setDescription('User to add as staff')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('role')
                .setDescription('Staff role type')
                .setRequired(true)
                .addChoices(
                    { name: 'Admin (can add/remove users)', value: ROLE_TYPES.ADMIN },
                    { name: 'Helper (can only add users)', value: ROLE_TYPES.HELPER }
                )),

    new SlashCommandBuilder()
        .setName('removestaff')
        .setDescription('Remove a staff member from your license')
        .setDMPermission(true)
        .addUserOption(option =>
            option.setName('user')
                .setDescription('Staff member to remove')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('staff')
        .setDescription('List all staff members for your license')
        .setDMPermission(true),

    new SlashCommandBuilder()
        .setName('mystaff')
        .setDescription('Show licenses where you are staff')
        .setDMPermission(true),

    // NEW COMMAND: All Users
    new SlashCommandBuilder()
        .setName('allusers')
        .setDescription('Show all licenses with authorized users and staff (Bot Owner Only)')
        .setDMPermission(true)
];

client.once('ready', async () => {
    logger.info(`Bot logged in as ${client.user.tag}`);
    
    // Initialize database
    await initializeDatabase();
    
    // Register slash commands
    try {
        const rest = require('@discordjs/rest');
        const { Routes } = require('discord-api-types/v9');
        
        const restClient = new rest.REST({ version: '9' }).setToken(process.env.DISCORD_TOKEN);
        
        await restClient.put(
            Routes.applicationCommands(client.user.id),
            { body: commands }
        );
        logger.info('Successfully registered application commands.');
    } catch (error) {
        logger.error('Error registering commands:', error);
    }
});

// Interaction handling
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, user } = interaction;

    try {
        switch (commandName) {
            case 'createlicense':
                if (user.id !== process.env.BOT_OWNER_ID) {
                    logger.warn(`Unauthorized license creation attempt by ${user.tag}`);
                    return interaction.reply({ content: 'Only the bot owner can create licenses!', ephemeral: true });
                }

                const targetUser = interaction.options.getUser('user');
                
                // Check if user already has a license
                const existingLicense = await getUserLicense(targetUser.id);
                if (existingLicense) {
                    logger.warn(`License creation failed: User ${targetUser.tag} already has license ${existingLicense}`);
                    return interaction.reply({ content: `This user already has a license: ${existingLicense}`, ephemeral: true });
                }
                
                // Generate a unique license key
                const licenseKey = `license_${targetUser.id}_${Date.now()}`;
                
                const success = await createLicense(licenseKey, targetUser.id, targetUser.tag);
                
                if (success) {
                    const embed = new EmbedBuilder()
                        .setTitle('License Created Successfully')
                        .setColor(0x00ff00)
                        .addFields(
                            { name: 'License Key', value: licenseKey, inline: true },
                            { name: 'Owner', value: targetUser.tag, inline: true }
                        );

                    logger.info(`License created: ${licenseKey} for user ${targetUser.tag}`);
                    await interaction.reply({ embeds: [embed] });
                } else {
                    logger.error(`Failed to create license for user ${targetUser.tag}`);
                    await interaction.reply({ content: 'Failed to create license!', ephemeral: true });
                }
                break;

            case 'authorize':
                let userLicense = await getUserLicense(user.id);
                const specifiedLicenseKey = interaction.options.getString('licensekey');
                
                // If user specified a license key, use that
                if (specifiedLicenseKey) {
                    // Check if user has permission to manage the specified license
                    const permissionCheck = await canUserManageLicense(user.id, specifiedLicenseKey, false);
                    if (!permissionCheck.canManage) {
                        logger.warn(`User ${user.tag} attempted to authorize license ${specifiedLicenseKey} without permission`);
                        return interaction.reply({ content: 'You don\'t have permission to manage this license!', ephemeral: true });
                    }
                    userLicense = specifiedLicenseKey;
                } else {
                    // No license key specified - use user's own license or check staff roles
                    if (!userLicense) {
                        // Check if user is staff for any license
                        const staffRoles = await getUserStaffRoles(user.id);
                        if (staffRoles.length === 0) {
                            logger.warn(`User ${user.tag} attempted to authorize without a license or staff role`);
                            return interaction.reply({ content: 'You don\'t have a license or staff permissions!', ephemeral: true });
                        }
                        
                        // If user has multiple staff roles, require license key
                        if (staffRoles.length > 1) {
                            const licenseList = staffRoles.map(role => 
                                `• **${role.license_key}** (${role.role_type} for ${role.owner_tag})`
                            ).join('\n');
                            
                            return interaction.reply({ 
                                content: `You have staff access to multiple licenses. Please specify which license to use with the \`licensekey\` option.\n\nYour staff roles:\n${licenseList}`, 
                                ephemeral: true 
                            });
                        }
                        
                        // Use the first (and only) license they have access to
                        userLicense = staffRoles[0].license_key;
                    }
                }

                // Final permission check
                const authPermission = await canUserManageLicense(user.id, userLicense, false);
                if (!authPermission.canManage) {
                    logger.warn(`User ${user.tag} attempted to authorize without permission for license ${userLicense}`);
                    return interaction.reply({ content: 'You don\'t have permission to manage this license!', ephemeral: true });
                }

                // Check if license is paused
                const isPausedAuth = await isLicensePaused(userLicense);
                if (isPausedAuth) {
                    logger.warn(`User ${user.tag} attempted to authorize with paused license ${userLicense}`);
                    return interaction.reply({ content: 'This license is currently paused. Contact the bot owner.', ephemeral: true });
                }

                const usernameToAdd = interaction.options.getString('username');
                const vehicleToAdd = interaction.options.getString('vehicle');

                const addResult = await addUserToLicense(userLicense, usernameToAdd, vehicleToAdd);

                if (addResult.success) {
                    const roleInfo = authPermission.isOwner ? 'Owner' : authPermission.role.charAt(0).toUpperCase() + authPermission.role.slice(1);
                    const embed = new EmbedBuilder()
                        .setTitle('User Authorized')
                        .setColor(0x00ff00)
                        .addFields(
                            { name: 'Username', value: usernameToAdd, inline: true },
                            { name: 'Authorization', value: addResult.forAllVehicles ? 'ALL Vehicles' : `Vehicle: ${vehicleToAdd}`, inline: true },
                            { name: 'License', value: userLicense, inline: true },
                            { name: 'Added By', value: `${user.tag} (${roleInfo})`, inline: true }
                        );
                    await interaction.reply({ embeds: [embed] });
                } else {
                    await interaction.reply({ content: addResult.message || 'An error occurred!', ephemeral: true });
                }
                break;

            case 'deauthorize':
                let userLicense2 = await getUserLicense(user.id);
                const specifiedLicenseKey2 = interaction.options.getString('licensekey');
                
                // If user specified a license key, use that
                if (specifiedLicenseKey2) {
                    // Check if user has permission to manage the specified license (require admin for deauthorization)
                    const permissionCheck = await canUserManageLicense(user.id, specifiedLicenseKey2, true);
                    if (!permissionCheck.canManage) {
                        const roleMessage = permissionCheck.role === ROLE_TYPES.HELPER ? 
                            'Helpers can only add users, not remove them. Ask an admin or license owner.' : 
                            'You don\'t have permission to manage this license!';
                        logger.warn(`User ${user.tag} attempted to deauthorize license ${specifiedLicenseKey2} without permission`);
                        return interaction.reply({ content: roleMessage, ephemeral: true });
                    }
                    userLicense2 = specifiedLicenseKey2;
                } else {
                    // No license key specified - use user's own license or check staff roles
                    if (!userLicense2) {
                        // Check if user is staff for any license
                        const staffRoles = await getUserStaffRoles(user.id);
                        if (staffRoles.length === 0) {
                            logger.warn(`User ${user.tag} attempted to deauthorize without a license or staff role`);
                            return interaction.reply({ content: 'You don\'t have a license or staff permissions!', ephemeral: true });
                        }
                        
                        // If user has multiple staff roles, require license key
                        if (staffRoles.length > 1) {
                            const licenseList = staffRoles.map(role => 
                                `• **${role.license_key}** (${role.role_type} for ${role.owner_tag})`
                            ).join('\n');
                            
                            return interaction.reply({ 
                                content: `You have staff access to multiple licenses. Please specify which license to use with the \`licensekey\` option.\n\nYour staff roles:\n${licenseList}`, 
                                ephemeral: true 
                            });
                        }
                        
                        // Use the first (and only) license they have access to
                        userLicense2 = staffRoles[0].license_key;
                    }
                }

                // Final permission check (require admin role for deauthorization)
                const deauthPermission = await canUserManageLicense(user.id, userLicense2, true);
                if (!deauthPermission.canManage) {
                    const roleMessage = deauthPermission.role === ROLE_TYPES.HELPER ? 
                        'Helpers can only add users, not remove them. Ask an admin or license owner.' : 
                        'You don\'t have permission to manage this license!';
                    logger.warn(`User ${user.tag} attempted to deauthorize without permission for license ${userLicense2}`);
                    return interaction.reply({ content: roleMessage, ephemeral: true });
                }

                // Check if license is paused
                const isPausedDeauth = await isLicensePaused(userLicense2);
                if (isPausedDeauth) {
                    logger.warn(`User ${user.tag} attempted to deauthorize with paused license ${userLicense2}`);
                    return interaction.reply({ content: 'This license is currently paused. Contact the bot owner.', ephemeral: true });
                }

                const usernameToRemove = interaction.options.getString('username');
                const vehicleToRemove = interaction.options.getString('vehicle');

                const removeSuccess = await removeUserFromLicense(userLicense2, usernameToRemove, vehicleToRemove);

                if (removeSuccess) {
                    const action = vehicleToRemove ? `vehicle ${vehicleToRemove}` : 'ALL authorization';
                    const roleInfo = deauthPermission.isOwner ? 'Owner' : deauthPermission.role.charAt(0).toUpperCase() + deauthPermission.role.slice(1);
                    const embed = new EmbedBuilder()
                        .setTitle('User Deauthorized')
                        .setColor(0xff0000)
                        .addFields(
                            { name: 'Username', value: usernameToRemove, inline: true },
                            { name: 'Action', value: `Removed ${action}`, inline: true },
                            { name: 'License', value: userLicense2, inline: true },
                            { name: 'Removed By', value: `${user.tag} (${roleInfo})`, inline: true }
                        );
                    await interaction.reply({ embeds: [embed] });
                } else {
                    await interaction.reply({ content: 'User/vehicle not found or an error occurred!', ephemeral: true });
                }
                break;

            case 'authorized':
                let userLicense3 = await getUserLicense(user.id);
                const specifiedLicenseKey3 = interaction.options.getString('licensekey');
                
                // If user specified a license key, use that
                if (specifiedLicenseKey3) {
                    // Check if user has permission to view the specified license
                    const permissionCheck = await canUserManageLicense(user.id, specifiedLicenseKey3, false);
                    if (!permissionCheck.canManage) {
                        logger.warn(`User ${user.tag} attempted to view license ${specifiedLicenseKey3} without permission`);
                        return interaction.reply({ content: 'You don\'t have permission to view this license!', ephemeral: true });
                    }
                    userLicense3 = specifiedLicenseKey3;
                } else {
                    // No license key specified - use user's own license or check staff roles
                    if (!userLicense3) {
                        // Check if user is staff for any license
                        const staffRoles = await getUserStaffRoles(user.id);
                        if (staffRoles.length === 0) {
                            logger.warn(`User ${user.tag} attempted to view authorized users without a license or staff role`);
                            return interaction.reply({ content: 'You don\'t have a license or staff permissions!', ephemeral: true });
                        }
                        
                        // If user has multiple staff roles, require license key
                        if (staffRoles.length > 1) {
                            const licenseList = staffRoles.map(role => 
                                `• **${role.license_key}** (${role.role_type} for ${role.owner_tag})`
                            ).join('\n');
                            
                            return interaction.reply({ 
                                content: `You have staff access to multiple licenses. Please specify which license to view with the \`licensekey\` option.\n\nYour staff roles:\n${licenseList}`, 
                                ephemeral: true 
                            });
                        }
                        
                        // Use the first (and only) license they have access to
                        userLicense3 = staffRoles[0].license_key;
                    }
                }

                // Final permission check
                const viewPermission = await canUserManageLicense(user.id, userLicense3, false);
                if (!viewPermission.canManage) {
                    logger.warn(`User ${user.tag} attempted to view authorized users without permission for license ${userLicense3}`);
                    return interaction.reply({ content: 'You don\'t have permission to view this license!', ephemeral: true });
                }

                // Check if license is paused
                const isPausedView = await isLicensePaused(userLicense3);
                const authorizedUsers = await getUsersForLicense(userLicense3);
                
                // Group users with their vehicles
                const userVehicles = {};
                authorizedUsers.forEach(({ username, vehicle }) => {
                    if (!userVehicles[username]) {
                        userVehicles[username] = [];
                    }
                    userVehicles[username].push(vehicle === ALL_VEHICLES ? 'ALL Vehicles' : vehicle);
                });

                let userList = 'None';
                if (Object.keys(userVehicles).length > 0) {
                    userList = Object.entries(userVehicles)
                        .map(([username, vehicles]) => 
                            `${username}: ${vehicles.join(', ')}`)
                        .join('\n');
                }

                const totalUsers = Object.keys(userVehicles).length;
                const totalAuthorizations = authorizedUsers.length;

                const roleInfo = viewPermission.isOwner ? 'Owner' : viewPermission.role.charAt(0).toUpperCase() + viewPermission.role.slice(1);
                const embed = new EmbedBuilder()
                    .setTitle('Authorized Users')
                    .setColor(isPausedView ? 0xff9900 : 0x0099ff)
                    .addFields(
                        { name: 'License', value: userLicense3, inline: true },
                        { name: 'Status', value: isPausedView ? '⏸️ PAUSED' : '✅ ACTIVE', inline: true },
                        { name: 'Your Role', value: roleInfo, inline: true },
                        { name: 'Total Users', value: totalUsers.toString(), inline: true },
                        { name: 'Total Authorizations', value: totalAuthorizations.toString(), inline: true },
                        { name: 'Users & Vehicles', value: userList, inline: false }
                    );

                await interaction.reply({ embeds: [embed] });
                break;

            case 'mylicense':
                const myLicense = await getUserLicense(user.id);
                if (!myLicense) {
                    // Check if user is staff for any licenses
                    const staffRoles = await getUserStaffRoles(user.id);
                    if (staffRoles.length === 0) {
                        logger.warn(`User ${user.tag} attempted to view license info without a license`);
                        return interaction.reply({ content: 'You don\'t have a license! Contact the bot owner.', ephemeral: true });
                    }
                    
                    // Show staff roles instead
                    const staffList = staffRoles.map(role => 
                        `• **${role.license_key}**\n  Role: ${role.role_type}\n  Owner: ${role.owner_tag}`
                    ).join('\n\n');
                    
                    const staffEmbed = new EmbedBuilder()
                        .setTitle('Your Staff Roles')
                        .setColor(0x0099ff)
                        .setDescription(`You don't own a license but have staff access to:\n\n${staffList}`)
                        .addFields(
                            { name: 'Admin Permissions', value: '• Add users\n• Remove users\n• View authorized users', inline: true },
                            { name: 'Helper Permissions', value: '• Add users\n• View authorized users', inline: true }
                        );
                    
                    return interaction.reply({ embeds: [staffEmbed], ephemeral: true });
                }

                // Check if license is paused
                const isPausedMy = await isLicensePaused(myLicense);
                const myUsers = await getUsersForLicense(myLicense);
                const myUserCount = new Set(myUsers.map(u => u.username)).size;
                const myAuthorizationCount = myUsers.length;

                // Get staff members for this license
                const staffMembers = await getLicenseStaff(myLicense);
                const adminCount = staffMembers.filter(s => s.role_type === ROLE_TYPES.ADMIN).length;
                const helperCount = staffMembers.filter(s => s.role_type === ROLE_TYPES.HELPER).length;

                const embed4 = new EmbedBuilder()
                    .setTitle('Your License Information')
                    .setColor(isPausedMy ? 0xff9900 : 0x0099ff)
                    .addFields(
                        { name: 'License Key', value: myLicense, inline: true },
                        { name: 'Status', value: isPausedMy ? '⏸️ PAUSED' : '✅ ACTIVE', inline: true },
                        { name: 'Authorized Users', value: myUserCount.toString(), inline: true },
                        { name: 'Total Authorizations', value: myAuthorizationCount.toString(), inline: true },
                        { name: 'Staff Members', value: `Admins: ${adminCount}\nHelpers: ${helperCount}`, inline: true }
                    );

                await interaction.reply({ embeds: [embed4], ephemeral: true });
                break;

            case 'deletelicense':
                if (user.id !== process.env.BOT_OWNER_ID) {
                    logger.warn(`Unauthorized license deletion attempt by ${user.tag}`);
                    return interaction.reply({ content: 'Only the bot owner can delete licenses!', ephemeral: true });
                }

                const keyToDelete = interaction.options.getString('licensekey');
                
                // Check if license exists
                const licenseCheck = await pool.query(
                    'SELECT license_key FROM licenses WHERE license_key = $1',
                    [keyToDelete]
                );
                
                if (licenseCheck.rows.length === 0) {
                    logger.warn(`License deletion failed: Key ${keyToDelete} not found`);
                    return interaction.reply({ content: 'License key not found!', ephemeral: true });
                }

                const deleteSuccess = await deleteLicense(keyToDelete);

                if (deleteSuccess) {
                    logger.info(`License deleted: ${keyToDelete}`);
                    await interaction.reply({ content: `License ${keyToDelete} deleted successfully!` });
                } else {
                    logger.error(`Failed to delete license: ${keyToDelete}`);
                    await interaction.reply({ content: 'Failed to delete license!', ephemeral: true });
                }
                break;

            case 'pauselicense':
                if (user.id !== process.env.BOT_OWNER_ID) {
                    logger.warn(`Unauthorized license pause attempt by ${user.tag}`);
                    return interaction.reply({ content: 'Only the bot owner can pause licenses!', ephemeral: true });
                }

                const userToPause = interaction.options.getUser('user');
                const userLicenseToPause = await getUserLicense(userToPause.id);
                
                if (!userLicenseToPause) {
                    logger.warn(`License pause failed: User ${userToPause.tag} does not have a license`);
                    return interaction.reply({ content: 'This user does not have a license!', ephemeral: true });
                }

                const pauseResult = await pauseLicense(userLicenseToPause, userToPause.id, userToPause.tag);

                if (pauseResult.success) {
                    logger.info(`License paused: ${userLicenseToPause} for user ${userToPause.tag}`);
                    await interaction.reply({ content: `License for ${userToPause.tag} has been paused!` });
                } else {
                    logger.error(`Failed to pause license: ${userLicenseToPause}`);
                    await interaction.reply({ content: pauseResult.message || 'Failed to pause license!', ephemeral: true });
                }
                break;

            case 'unpauselicense':
                if (user.id !== process.env.BOT_OWNER_ID) {
                    logger.warn(`Unauthorized license unpause attempt by ${user.tag}`);
                    return interaction.reply({ content: 'Only the bot owner can unpause licenses!', ephemeral: true });
                }

                const userToUnpause = interaction.options.getUser('user');
                const userLicenseToUnpause = await getUserLicense(userToUnpause.id);
                
                if (!userLicenseToUnpause) {
                    logger.warn(`License unpause failed: User ${userToUnpause.tag} does not have a license`);
                    return interaction.reply({ content: 'This user does not have a license!', ephemeral: true });
                }

                const unpauseResult = await unpauseLicense(userLicenseToUnpause);

                if (unpauseResult.success) {
                    logger.info(`License unpaused: ${userLicenseToUnpause} for user ${userToUnpause.tag}`);
                    await interaction.reply({ content: `License for ${userToUnpause.tag} has been unpaused!` });
                } else {
                    logger.error(`Failed to unpause license: ${userLicenseToUnpause}`);
                    await interaction.reply({ content: unpauseResult.message || 'Failed to unpause license!', ephemeral: true });
                }
                break;
                
            case 'licenseinfo':
                if (user.id !== process.env.BOT_OWNER_ID) {
                    logger.warn(`Unauthorized license info attempt by ${user.tag}`);
                    return interaction.reply({ content: 'Only the bot owner can check license information!', ephemeral: true });
                }

                const targetUserInfo = interaction.options.getUser('user');
                const licenseInfo = await getLicenseInfo(targetUserInfo.id);
                
                if (!licenseInfo) {
                    logger.warn(`License info not found for user ${targetUserInfo.tag}`);
                    return interaction.reply({ content: 'This user does not have a license!', ephemeral: true });
                }

                // Format user list
                let userListInfo = 'None';
                if (licenseInfo.totalUsers > 0) {
                    userListInfo = Object.entries(licenseInfo.authorizedUsers)
                        .map(([username, vehicles]) => 
                            `${username}: ${vehicles.join(', ')}`)
                        .join('\n');
                }

                const embedInfo = new EmbedBuilder()
                    .setTitle('License Information')
                    .setColor(licenseInfo.isPaused ? 0xff9900 : 0x0099ff)
                    .addFields(
                        { name: 'License Key', value: licenseInfo.licenseKey, inline: true },
                        { name: 'Owner', value: licenseInfo.ownerTag, inline: true },
                        { name: 'Status', value: licenseInfo.isPaused ? '⏸️ PAUSED' : '✅ ACTIVE', inline: true },
                        { name: 'Created At', value: new Date(licenseInfo.createdAt).toLocaleDateString(), inline: true },
                        { name: 'Total Users', value: licenseInfo.totalUsers.toString(), inline: true },
                        { name: 'Total Authorizations', value: licenseInfo.totalAuthorizations.toString(), inline: true },
                        { name: 'Users & Vehicles', value: userListInfo, inline: false }
                    )
                    .setFooter({ text: `User ID: ${targetUserInfo.id}` })
                    .setTimestamp();

                await interaction.reply({ embeds: [embedInfo] });
                break;

            case 'transferlicense':
                if (user.id !== process.env.BOT_OWNER_ID) {
                    logger.warn(`Unauthorized license transfer attempt by ${user.tag}`);
                    return interaction.reply({ content: 'Only the bot owner can transfer licenses!', ephemeral: true });
                }

                const fromUser = interaction.options.getUser('from');
                const toUser = interaction.options.getUser('to');

                // Check if users are the same
                if (fromUser.id === toUser.id) {
                    logger.warn(`License transfer failed: Same user specified for from and to`);
                    return interaction.reply({ content: 'Cannot transfer license to the same user!', ephemeral: true });
                }

                // Check if old owner has a license
                const fromUserLicense = await getUserLicense(fromUser.id);
                if (!fromUserLicense) {
                    logger.warn(`License transfer failed: User ${fromUser.tag} does not have a license`);
                    return interaction.reply({ content: `User ${fromUser.tag} does not have a license!`, ephemeral: true });
                }

                // Check if new owner already has a license
                const toUserLicense = await getUserLicense(toUser.id);
                if (toUserLicense) {
                    logger.warn(`License transfer failed: User ${toUser.tag} already has license ${toUserLicense}`);
                    return interaction.reply({ content: `User ${toUser.tag} already has a license: ${toUserLicense}`, ephemeral: true });
                }

                const dbClient = await pool.connect();
                try {
                    await dbClient.query('BEGIN');

                    // Update the license owner in licenses table
                    const updateResult = await dbClient.query(
                        'UPDATE licenses SET owner_id = $1, owner_tag = $2 WHERE license_key = $3',
                        [toUser.id, toUser.tag, fromUserLicense]
                    );

                    if (updateResult.rowCount === 0) {
                        await dbClient.query('ROLLBACK');
                        logger.error(`License transfer failed: Could not update license ${fromUserLicense}`);
                        return interaction.reply({ content: 'Failed to transfer license!', ephemeral: true });
                    }

                    // Update paused_licenses table if the license is paused
                    await dbClient.query(
                        'UPDATE paused_licenses SET owner_id = $1, owner_tag = $2 WHERE license_key = $3',
                        [toUser.id, toUser.tag, fromUserLicense]
                    );

                    await dbClient.query('COMMIT');

                    // Log the transfer
                    logger.info(`License transferred: ${fromUserLicense} from ${fromUser.tag} to ${toUser.tag}`);

                    // Send success embed
                    const transferEmbed = new EmbedBuilder()
                        .setTitle('License Transferred Successfully')
                        .setColor(0x00ff00)
                        .addFields(
                            { name: 'License Key', value: fromUserLicense, inline: true },
                            { name: 'Previous Owner', value: fromUser.tag, inline: true },
                            { name: 'New Owner', value: toUser.tag, inline: true }
                        )
                        .setTimestamp();

                    await interaction.reply({ embeds: [transferEmbed] });

                } catch (error) {
                    await dbClient.query('ROLLBACK');
                    logger.error('Error transferring license:', error);
                    await interaction.reply({ content: 'An error occurred while transferring the license!', ephemeral: true });
                } finally {
                    dbClient.release();
                }
                break;

            case 'addstaff':
                const userLicense4 = await getUserLicense(user.id);
                if (!userLicense4) {
                    logger.warn(`User ${user.tag} attempted to add staff without a license`);
                    return interaction.reply({ content: 'You don\'t have a license!', ephemeral: true });
                }

                const staffUserToAdd = interaction.options.getUser('user');
                const staffRole = interaction.options.getString('role');

                const addStaffResult = await addLicenseStaff(userLicense4, staffUserToAdd.id, staffUserToAdd.tag, staffRole, user.id);

                if (addStaffResult.success) {
                    const embed = new EmbedBuilder()
                        .setTitle('Staff Member Added')
                        .setColor(0x00ff00)
                        .addFields(
                            { name: 'User', value: staffUserToAdd.tag, inline: true },
                            { name: 'Role', value: staffRole.charAt(0).toUpperCase() + staffRole.slice(1), inline: true },
                            { name: 'License', value: userLicense4, inline: true }
                        );
                    await interaction.reply({ embeds: [embed] });
                } else {
                    await interaction.reply({ content: addStaffResult.message || 'Failed to add staff member!', ephemeral: true });
                }
                break;

            case 'removestaff':
                const userLicense5 = await getUserLicense(user.id);
                if (!userLicense5) {
                    logger.warn(`User ${user.tag} attempted to remove staff without a license`);
                    return interaction.reply({ content: 'You don\'t have a license!', ephemeral: true });
                }

                const staffUserToRemove = interaction.options.getUser('user');

                const removeStaffResult = await removeLicenseStaff(userLicense5, staffUserToRemove.id, user.id);

                if (removeStaffResult.success) {
                    const embed = new EmbedBuilder()
                        .setTitle('Staff Member Removed')
                        .setColor(0xff0000)
                        .addFields(
                            { name: 'User', value: staffUserToRemove.tag, inline: true },
                            { name: 'License', value: userLicense5, inline: true }
                        );
                    await interaction.reply({ embeds: [embed] });
                } else {
                    await interaction.reply({ content: removeStaffResult.message || 'Failed to remove staff member!', ephemeral: true });
                }
                break;

            case 'staff':
                const userLicense6 = await getUserLicense(user.id);
                if (!userLicense6) {
                    logger.warn(`User ${user.tag} attempted to view staff without a license`);
                    return interaction.reply({ content: 'You don\'t have a license!', ephemeral: true });
                }

                const staffMembersList = await getLicenseStaff(userLicense6);
                
                let staffList = 'None';
                if (staffMembersList.length > 0) {
                    staffList = staffMembersList.map(staff => 
                        `• **${staff.user_tag}** (${staff.role_type})\n  Added by: ${staff.added_by}\n  Added: ${new Date(staff.added_at).toLocaleDateString()}`
                    ).join('\n\n');
                }

                const staffEmbed = new EmbedBuilder()
                    .setTitle('License Staff Members')
                    .setColor(0x0099ff)
                    .addFields(
                        { name: 'License', value: userLicense6, inline: true },
                        { name: 'Total Staff', value: staffMembersList.length.toString(), inline: true },
                        { name: 'Staff List', value: staffList, inline: false }
                    )
                    .addFields(
                        { name: 'Role Permissions', value: '**Admin**: Can add/remove users\n**Helper**: Can only add users', inline: false }
                    );

                await interaction.reply({ embeds: [staffEmbed] });
                break;

            case 'mystaff':
                const staffRoles = await getUserStaffRoles(user.id);
                if (staffRoles.length === 0) {
                    return interaction.reply({ content: 'You are not a staff member for any licenses.', ephemeral: true });
                }

                const staffRoleList = staffRoles.map(role => 
                    `• **${role.license_key}**\n  Role: ${role.role_type}\n  Owner: ${role.owner_tag}`
                ).join('\n\n');

                const myStaffEmbed = new EmbedBuilder()
                    .setTitle('Your Staff Roles')
                    .setColor(0x0099ff)
                    .setDescription(`You are staff for the following licenses:\n\n${staffRoleList}`)
                    .addFields(
                        { name: 'Admin Permissions', value: '• Add users\n• Remove users\n• View authorized users', inline: true },
                        { name: 'Helper Permissions', value: '• Add users\n• View authorized users', inline: true }
                    );

                await interaction.reply({ embeds: [myStaffEmbed], ephemeral: true });
                break;

            // NEW COMMAND: All Users
            case 'allusers':
                if (user.id !== process.env.BOT_OWNER_ID) {
                    logger.warn(`Unauthorized allusers command attempt by ${user.tag}`);
                    return interaction.reply({ content: 'Only the bot owner can view all users!', ephemeral: true });
                }

                // Defer the reply since this might take some time
                await interaction.deferReply();

                const allLicenses = await getAllLicensesWithDetails();
                
                if (allLicenses.length === 0) {
                    return interaction.editReply({ content: 'No licenses found in the system!', ephemeral: true });
                }

                // Create embeds (multiple if needed due to Discord's embed limits)
                const embeds = [];
                let currentEmbed = new EmbedBuilder()
                    .setTitle('📊 All Licenses Overview')
                    .setColor(0x0099ff)
                    .setDescription(`Total Licenses: ${allLicenses.length}\n\nShowing all license owners with their authorized users and staff members.`)
                    .setTimestamp();

                let fieldCount = 0;
                const maxFieldsPerEmbed = 25; // Discord limit

                for (const license of allLicenses) {
                    // Format authorized users
                    let usersText = 'None';
                    if (license.totalUsers > 0) {
                        usersText = Object.entries(license.authorizedUsers)
                            .slice(0, 5) // Limit to 5 users per license in overview
                            .map(([username, vehicles]) => 
                                `• ${username}: ${vehicles.slice(0, 3).join(', ')}${vehicles.length > 3 ? '...' : ''}`
                            )
                            .join('\n');
                        if (license.totalUsers > 5) {
                            usersText += `\n... and ${license.totalUsers - 5} more users`;
                        }
                    }

                    // Format staff members
                    let staffText = 'None';
                    if (license.totalStaff > 0) {
                        staffText = license.staffMembers
                            .slice(0, 3) // Limit to 3 staff per license in overview
                            .map(staff => 
                                `• ${staff.user_tag} (${staff.role_type})`
                            )
                            .join('\n');
                        if (license.totalStaff > 3) {
                            staffText += `\n... and ${license.totalStaff - 3} more staff`;
                        }
                    }

                    const licenseField = {
                        name: `🔑 ${license.licenseKey} ${license.isPaused ? '⏸️' : '✅'}`,
                        value: `**Owner:** ${license.ownerTag}\n` +
                               `**Status:** ${license.isPaused ? 'PAUSED' : 'ACTIVE'}\n` +
                               `**Users:** ${license.totalUsers} (${license.totalAuthorizations} auths)\n` +
                               `**Staff:** ${license.totalStaff}\n` +
                               `**Authorized Users:**\n${usersText}\n` +
                               `**Staff Members:**\n${staffText}`,
                        inline: false
                    };

                    // Check if we need to start a new embed
                    if (fieldCount >= maxFieldsPerEmbed) {
                        embeds.push(currentEmbed);
                        currentEmbed = new EmbedBuilder()
                            .setTitle('📊 All Licenses Overview (Continued)')
                            .setColor(0x0099ff)
                            .setTimestamp();
                        fieldCount = 0;
                    }

                    currentEmbed.addFields(licenseField);
                    fieldCount++;
                }

                // Add the last embed
                embeds.push(currentEmbed);

                // Add summary to the first embed
                const totalUsers = allLicenses.reduce((sum, license) => sum + license.totalUsers, 0);
                const totalAuthorizations = allLicenses.reduce((sum, license) => sum + license.totalAuthorizations, 0);
                const totalStaff = allLicenses.reduce((sum, license) => sum + license.totalStaff, 0);
                const pausedLicenses = allLicenses.filter(license => license.isPaused).length;

                embeds[0].addFields({
                    name: '📈 System Summary',
                    value: `**Total Licenses:** ${allLicenses.length}\n` +
                           `**Paused Licenses:** ${pausedLicenses}\n` +
                           `**Total Users:** ${totalUsers}\n` +
                           `**Total Authorizations:** ${totalAuthorizations}\n` +
                           `**Total Staff:** ${totalStaff}`,
                    inline: false
                });

                // Send all embeds
                for (let i = 0; i < embeds.length; i++) {
                    if (i === 0) {
                        await interaction.editReply({ embeds: [embeds[i]] });
                    } else {
                        await interaction.followUp({ embeds: [embeds[i]] });
                    }
                }
                break;
        }
    } catch (error) {
        logger.error('Command error:', error);
        if (!interaction.replied) {
            await interaction.reply({ content: 'An error occurred while processing the command!', ephemeral: true });
        }
    }
});

// Add express server for health checks (required by Railway)
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/health', async (req, res) => {
    try {
        // Test database connection
        await pool.query('SELECT 1');
        res.status(200).json({ 
            status: 'OK', 
            bot: client.user ? 'Connected' : 'Disconnected',
            database: 'Connected',
            timestamp: new Date().toISOString() 
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'ERROR', 
            bot: client.user ? 'Connected' : 'Disconnected',
            database: 'Disconnected',
            error: error.message,
            timestamp: new Date().toISOString() 
        });
    }
});

app.listen(PORT, () => {
    logger.info(`Health check server running on port ${PORT}`);
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
    logger.info('Shutting down gracefully...');
    await pool.end();
    client.destroy();
    process.exit(0);
});

client.login(process.env.DISCORD_TOKEN)
    .then(() => logger.info('Bot login successful'))
    .catch(error => {
        logger.error(`Bot login failed: ${error.message}`);
        process.exit(1);
    });
