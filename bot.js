const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { Pool } = require('pg');
const logger = require('./logger');
require('dotenv').config();

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// PostgreSQL connection pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Special value for "all vehicles" authorization
const ALL_VEHICLES = '*ALL*';

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

// Command definitions
const commands = [
    new SlashCommandBuilder()
        .setName('createlicense')
        .setDescription('Create a new license (Bot Owner Only)')
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
        .setDescription('Add a user to your approved list (with optional vehicle)')
        .addStringOption(option =>
            option.setName('username')
                .setDescription('Roblox username to authorize')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('vehicle')
                .setDescription('Specific vehicle to authorize (leave empty for ALL vehicles)')
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName('deauthorize')
        .setDescription('Remove a user/vehicle from your approved list')
        .addStringOption(option =>
            option.setName('username')
                .setDescription('Roblox username to deauthorize')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('vehicle')
                .setDescription('Specific vehicle to remove (leave empty to remove ALL authorization)')
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName('authorized')
        .setDescription('List all authorized users and their vehicles'),

    new SlashCommandBuilder()
        .setName('mylicense')
        .setDescription('Show your license information'),

    new SlashCommandBuilder()
        .setName('deletelicense')
        .setDescription('Delete a license (Bot Owner Only)')
        .addStringOption(option =>
            option.setName('licensekey')
                .setDescription('License key to delete')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('pauselicense')
        .setDescription('Pause a license (Bot Owner Only)')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('User whose license to pause')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('unpauselicense')
        .setDescription('Unpause a license (Bot Owner Only)')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('User whose license to unpause')
                .setRequired(true)),
                
    new SlashCommandBuilder()
        .setName('licenseinfo')
        .setDescription('Check license information for a user (Bot Owner Only)')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('User to check license information for')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('transferlicense')
        .setDescription('Transfer a license from one user to another (Bot Owner Only)')
        .addUserOption(option =>
            option.setName('from')
                .setDescription('Current license owner')
                .setRequired(true))
        .addUserOption(option =>
            option.setName('to')
                .setDescription('New license owner')
                .setRequired(true))
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
                const userLicense = await getUserLicense(user.id);
                if (!userLicense) {
                    logger.warn(`User ${user.tag} attempted to authorize without a license`);
                    return interaction.reply({ content: 'You don\'t have a license! Contact the bot owner.', ephemeral: true });
                }

                // Check if license is paused
                const isPausedAuth = await isLicensePaused(userLicense);
                if (isPausedAuth) {
                    logger.warn(`User ${user.tag} attempted to authorize with paused license ${userLicense}`);
                    return interaction.reply({ content: 'Your license is currently paused. Contact the bot owner.', ephemeral: true });
                }

                const usernameToAdd = interaction.options.getString('username');
                const vehicleToAdd = interaction.options.getString('vehicle');

                const addResult = await addUserToLicense(userLicense, usernameToAdd, vehicleToAdd);

                if (addResult.success) {
                    const embed = new EmbedBuilder()
                        .setTitle('User Authorized')
                        .setColor(0x00ff00)
                        .addFields(
                            { name: 'Username', value: usernameToAdd, inline: true },
                            { name: 'Authorization', value: addResult.forAllVehicles ? 'ALL Vehicles' : `Vehicle: ${vehicleToAdd}`, inline: true },
                            { name: 'License', value: userLicense, inline: true }
                        );
                    await interaction.reply({ embeds: [embed] });
                } else {
                    await interaction.reply({ content: addResult.message || 'An error occurred!', ephemeral: true });
                }
                break;

            case 'deauthorize':
                const userLicense2 = await getUserLicense(user.id);
                if (!userLicense2) {
                    logger.warn(`User ${user.tag} attempted to deauthorize without a license`);
                    return interaction.reply({ content: 'You don\'t have a license! Contact the bot owner.', ephemeral: true });
                }

                // Check if license is paused
                const isPausedDeauth = await isLicensePaused(userLicense2);
                if (isPausedDeauth) {
                    logger.warn(`User ${user.tag} attempted to deauthorize with paused license ${userLicense2}`);
                    return interaction.reply({ content: 'Your license is currently paused. Contact the bot owner.', ephemeral: true });
                }

                const usernameToRemove = interaction.options.getString('username');
                const vehicleToRemove = interaction.options.getString('vehicle');

                const removeSuccess = await removeUserFromLicense(userLicense2, usernameToRemove, vehicleToRemove);

                if (removeSuccess) {
                    const action = vehicleToRemove ? `vehicle ${vehicleToRemove}` : 'ALL authorization';
                    const embed = new EmbedBuilder()
                        .setTitle('User Deauthorized')
                        .setColor(0xff0000)
                        .addFields(
                            { name: 'Username', value: usernameToRemove, inline: true },
                            { name: 'Action', value: `Removed ${action}`, inline: true },
                            { name: 'License', value: userLicense2, inline: true }
                        );
                    await interaction.reply({ embeds: [embed] });
                } else {
                    await interaction.reply({ content: 'User/vehicle not found or an error occurred!', ephemeral: true });
                }
                break;

            case 'authorized':
                const userLicense3 = await getUserLicense(user.id);
                if (!userLicense3) {
                    logger.warn(`User ${user.tag} attempted to view authorized users without a license`);
                    return interaction.reply({ content: 'You don\'t have a license! Contact the bot owner.', ephemeral: true });
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

                const embed = new EmbedBuilder()
                    .setTitle('Authorized Users')
                    .setColor(isPausedView ? 0xff9900 : 0x0099ff)
                    .addFields(
                        { name: 'License', value: userLicense3, inline: true },
                        { name: 'Status', value: isPausedView ? '⏸️ PAUSED' : '✅ ACTIVE', inline: true },
                        { name: 'Total Users', value: totalUsers.toString(), inline: true },
                        { name: 'Total Authorizations', value: totalAuthorizations.toString(), inline: true },
                        { name: 'Users & Vehicles', value: userList, inline: false }
                    );

                await interaction.reply({ embeds: [embed] });
                break;

            case 'mylicense':
                const myLicense = await getUserLicense(user.id);
                if (!myLicense) {
                    logger.warn(`User ${user.tag} attempted to view license info without a license`);
                    return interaction.reply({ content: 'You don\'t have a license! Contact the bot owner.', ephemeral: true });
                }

                // Check if license is paused
                const isPausedMy = await isLicensePaused(myLicense);
                const myUsers = await getUsersForLicense(myLicense);
                const myUserCount = new Set(myUsers.map(u => u.username)).size;
                const myAuthorizationCount = myUsers.length;

                const embed4 = new EmbedBuilder()
                    .setTitle('Your License Information')
                    .setColor(isPausedMy ? 0xff9900 : 0x0099ff)
                    .addFields(
                        { name: 'License Key', value: myLicense, inline: true },
                        { name: 'Status', value: isPausedMy ? '⏸️ PAUSED' : '✅ ACTIVE', inline: true },
                        { name: 'Authorized Users', value: myUserCount.toString(), inline: true },
                        { name: 'Total Authorizations', value: myAuthorizationCount.toString(), inline: true }
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
