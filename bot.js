const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');
require('dotenv').config();

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// Configuration
const LICENSES_DIR = path.join(__dirname, 'licenses');
const LICENSES_FILE = path.join(__dirname, 'licenses.json');

// Special value for "all vehicles" authorization
const ALL_VEHICLES = '*ALL*';

// Ensure directories exist
async function initializeBot() {
    try {
        await fs.access(LICENSES_DIR);
        logger.info('Licenses directory exists');
    } catch {
        await fs.mkdir(LICENSES_DIR, { recursive: true });
        logger.info('Created licenses directory');
    }

    try {
        await fs.access(LICENSES_FILE);
        logger.info('Licenses file exists');
    } catch {
        await fs.writeFile(LICENSES_FILE, JSON.stringify({}));
        logger.info('Created licenses file');
    }
}

// License management functions
async function getLicenses() {
    try {
        const data = await fs.readFile(LICENSES_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        logger.error('Error reading licenses:', error);
        return {};
    }
}

async function saveLicenses(licenses) {
    try {
        await fs.writeFile(LICENSES_FILE, JSON.stringify(licenses, null, 2));
        return true;
    } catch (error) {
        logger.error('Error saving licenses:', error);
        return false;
    }
}

// Updated to parse username:vehicle format from TXT files
async function getUsersForLicense(licenseKey) {
    try {
        const filePath = path.join(LICENSES_DIR, `${licenseKey}.txt`);
        const data = await fs.readFile(filePath, 'utf8');
        
        return data.split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#'))
            .map(line => {
                // Parse "username:vehicle" format
                const parts = line.split(':');
                return {
                    username: parts[0].trim(),
                    vehicle: parts[1] ? parts[1].trim() : 'default'
                };
            });
    } catch (error) {
        logger.warn(`No users found for license ${licenseKey}`);
        return [];
    }
}

// Updated to save in username:vehicle format
async function saveUsersToLicense(licenseKey, users) {
    try {
        const filePath = path.join(LICENSES_DIR, `${licenseKey}.txt`);
        const content = '# Approved Users List\n# Format: username:vehicle\n# Add one entry per line\n' +
            users.map(user => `${user.username}:${user.vehicle}`).join('\n');
        
        await fs.writeFile(filePath, content);
        return true;
    } catch (error) {
        logger.error('Error saving users to license:', error);
        return false;
    }
}

// Updated to add user with specific vehicle or all vehicles
async function addUserToLicense(licenseKey, username, vehicle = null) {
    try {
        const users = await getUsersForLicense(licenseKey);
        
        if (vehicle === null) {
            // Authorize for ALL vehicles
            // Remove any existing specific vehicle entries for this user
            const filteredUsers = users.filter(u => u.username !== username);
            filteredUsers.push({ username, vehicle: ALL_VEHICLES });
            
            await saveUsersToLicense(licenseKey, filteredUsers);
            logger.info(`Added user ${username} for ALL vehicles to license ${licenseKey}`);
            return { success: true, forAllVehicles: true };
        } else {
            // Check if user already has access to all vehicles
            const hasAllAccess = users.some(u => u.username === username && u.vehicle === ALL_VEHICLES);
            if (hasAllAccess) {
                logger.warn(`User ${username} already has access to ALL vehicles in license ${licenseKey}`);
                return { success: false, message: 'User already has access to all vehicles' };
            }
            
            // Check if user already has this specific vehicle
            const hasSpecificVehicle = users.some(u => u.username === username && u.vehicle === vehicle);
            if (hasSpecificVehicle) {
                logger.warn(`User ${username} already has vehicle ${vehicle} in license ${licenseKey}`);
                return { success: false, message: 'User already has this vehicle' };
            }
            
            // Add specific vehicle
            users.push({ username, vehicle });
            await saveUsersToLicense(licenseKey, users);
            
            logger.info(`Added user ${username} with vehicle ${vehicle} to license ${licenseKey}`);
            return { success: true, forAllVehicles: false };
        }
    } catch (error) {
        logger.error('Error adding user to license:', error);
        return { success: false, message: 'Error adding user' };
    }
}

// Updated to remove specific vehicle from user or all vehicles
async function removeUserFromLicense(licenseKey, username, vehicle = null) {
    try {
        const users = await getUsersForLicense(licenseKey);
        
        if (vehicle) {
            // Remove specific vehicle for user
            const filteredUsers = users.filter(u => !(u.username === username && u.vehicle === vehicle));
            
            if (filteredUsers.length === users.length) {
                logger.warn(`Vehicle ${vehicle} not found for user ${username} in license ${licenseKey}`);
                return false;
            }
            
            await saveUsersToLicense(licenseKey, filteredUsers);
            logger.info(`Removed vehicle ${vehicle} from user ${username} in license ${licenseKey}`);
            return true;
        } else {
            // Remove ALL authorization for user (both specific vehicles and all vehicles)
            const filteredUsers = users.filter(u => u.username !== username);
            
            if (filteredUsers.length === users.length) {
                logger.warn(`User ${username} not found in license ${licenseKey}`);
                return false;
            }
            
            await saveUsersToLicense(licenseKey, filteredUsers);
            logger.info(`Removed ALL vehicles for user ${username} from license ${licenseKey}`);
            return true;
        }
    } catch (error) {
        logger.error('Error removing user from license:', error);
        return false;
    }
}

// Utility function to get user's license key
async function getUserLicense(userId) {
    const licenses = await getLicenses();
    return Object.entries(licenses).find(([key, data]) => data.ownerId === userId)?.[0];
}

// Command handlers - updated to make vehicle optional
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
                .setRequired(true))
];

client.once('ready', async () => {
    logger.info(`Bot logged in as ${client.user.tag}`);
    
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

    await initializeBot();
});

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
                
                const licenses = await getLicenses();

                licenses[licenseKey] = {
                    ownerId: targetUser.id,
                    ownerTag: targetUser.tag,
                    createdAt: new Date().toISOString()
                };

                const success = await saveLicenses(licenses);
                
                if (success) {
                    // Create the license file with header
                    const content = '# Approved Users List\n# Format: username:vehicle\n# Add one entry per line\n';
                    const filePath = path.join(LICENSES_DIR, `${licenseKey}.txt`);
                    await fs.writeFile(filePath, content);

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
                    .setColor(0x0099ff)
                    .addFields(
                        { name: 'License', value: userLicense3, inline: true },
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

                const myUsers = await getUsersForLicense(myLicense);
                const myUserCount = new Set(myUsers.map(u => u.username)).size;
                const myAuthorizationCount = myUsers.length;

                const embed4 = new EmbedBuilder()
                    .setTitle('Your License Information')
                    .setColor(0x0099ff)
                    .addFields(
                        { name: 'License Key', value: myLicense, inline: true },
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
                const allLicenses = await getLicenses();
                
                if (!allLicenses[keyToDelete]) {
                    logger.warn(`License deletion failed: Key ${keyToDelete} not found`);
                    return interaction.reply({ content: 'License key not found!', ephemeral: true });
                }

                delete allLicenses[keyToDelete];
                const deleteSuccess = await saveLicenses(allLicenses);

                if (deleteSuccess) {
                    // Delete the license file
                    try {
                        const filePath = path.join(LICENSES_DIR, `${keyToDelete}.txt`);
                        await fs.unlink(filePath);
                    } catch (error) {
                        logger.error('Error deleting license file:', error);
                    }

                    logger.info(`License deleted: ${keyToDelete}`);
                    await interaction.reply({ content: `License ${keyToDelete} deleted successfully!` });
                } else {
                    logger.error(`Failed to delete license: ${keyToDelete}`);
                    await interaction.reply({ content: 'Failed to delete license!', ephemeral: true });
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

app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'OK', 
        bot: client.user ? 'Connected' : 'Disconnected',
        timestamp: new Date().toISOString() 
    });
});

app.listen(PORT, () => {
    logger.info(`Health check server running on port ${PORT}`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    logger.info('Shutting down gracefully...');
    client.destroy();
    process.exit(0);
});

client.login(process.env.DISCORD_TOKEN)
    .then(() => logger.info('Bot login successful'))
    .catch(error => {
        logger.error(`Bot login failed: ${error.message}`);
        process.exit(1);
    });