import { homedir, platform } from 'os';
import { join } from 'path';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { exec } from "node:child_process";

// Fix for Windows ESM path resolution
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Setup logging
const LOG_FILE = join(__dirname, 'setup.log');

function logToFile(message, isError = false) {
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} - ${isError ? 'ERROR: ' : ''}${message}\n`;
    try {
        appendFileSync(LOG_FILE, logMessage);
        process.stdout.write(`${message}\n`);
    } catch (err) {
        process.stderr.write(`Failed to write to log file: ${err.message}\n`);
    }
}

// Setup global error handlers
process.on('uncaughtException', (error) => {
    logToFile(`Uncaught exception: ${error.message}`, true);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    logToFile(`Unhandled rejection: ${String(reason)}`, true);
    process.exit(1);
});

// Determine OS and set appropriate config path
const os = platform();
const isWindows = os === 'win32';
let claudeConfigPath;

switch (os) {
    case 'win32':
        claudeConfigPath = join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json');
        break;
    case 'darwin':
        claudeConfigPath = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
        break;
    case 'linux':
        claudeConfigPath = join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
        break;
    default:
        claudeConfigPath = join(homedir(), '.claude_desktop_config.json');
}

async function execAsync(command) {
    return new Promise((resolve, reject) => {
        const actualCommand = isWindows
            ? `cmd.exe /c ${command}`
            : command;

        exec(actualCommand, { timeout: 10000 }, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

// Backup configuration before removal
function createConfigBackup(configPath) {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `${configPath}.backup.${timestamp}`;

        if (existsSync(configPath)) {
            const configData = readFileSync(configPath, 'utf8');
            writeFileSync(backupPath, configData, 'utf8');
            logToFile(`Configuration backup created: ${backupPath}`);
            return backupPath;
        }
        return null;
    } catch (error) {
        logToFile(`Failed to create backup: ${error.message}`, true);
        return null;
    }
}

// Restore configuration from backup
function restoreFromBackup(backupPath) {
    if (!backupPath || !existsSync(backupPath)) {
        return false;
    }

    try {
        const backupData = readFileSync(backupPath, 'utf8');
        writeFileSync(claudeConfigPath, backupData, 'utf8');
        logToFile(`Configuration restored from backup: ${backupPath}`);
        return true;
    } catch (error) {
        logToFile(`Failed to restore from backup: ${error.message}`, true);
        return false;
    }
}

async function restartClaude() {
    try {
        const plat = process.platform;
        logToFile('Attempting to restart Claude...');

        // Try to kill Claude process first
        try {
            switch (plat) {
                case "win32":
                    await execAsync(`taskkill /F /IM "Claude.exe"`);
                    break;
                case "darwin":
                    await execAsync(`killall "Claude"`);
                    break;
                case "linux":
                    await execAsync(`pkill -f "claude"`);
                    break;
            }
            logToFile("Claude process terminated successfully");
        } catch (killError) {
            logToFile("Claude process not found or already terminated");
        }

        // Wait a bit to ensure process termination
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Try to start Claude
        try {
            if (plat === "win32") {
                logToFile("Windows: Claude restart skipped - please restart Claude manually");
            } else if (plat === "darwin") {
                await execAsync(`open -a "Claude"`);
                logToFile("✅ Claude has been restarted automatically!");
            } else if (plat === "linux") {
                await execAsync(`claude`);
                logToFile("✅ Claude has been restarted automatically!");
            } else {
                logToFile('To complete uninstallation, restart Claude if it\'s currently running');
            }
        } catch (startError) {
            logToFile(`Could not automatically restart Claude: ${startError.message}. Please restart it manually.`);
        }
    } catch (error) {
        logToFile(`Failed to restart Claude: ${error.message}. Please restart it manually.`, true);
    }
}

function removeDesktopCommanderConfig() {
    let backupPath = null;

    try {
        if (!existsSync(claudeConfigPath)) {
            logToFile(`Claude config file not found at: ${claudeConfigPath}`);
            logToFile('✅ Desktop Commander was not configured or already removed.');
            return true;
        }

        // Create backup before making changes
        backupPath = createConfigBackup(claudeConfigPath);

        // Read existing config
        let config;
        try {
            const configData = readFileSync(claudeConfigPath, 'utf8');
            config = JSON.parse(configData);
        } catch (readError) {
            throw new Error(`Failed to read config file: ${readError.message}`);
        }

        if (!config.mcpServers) {
            logToFile('No MCP servers configured in Claude.');
            logToFile('✅ Desktop Commander was not configured or already removed.');
            return true;
        }

        const serversToRemove = [];
        if (config.mcpServers["desktop-commander"]) {
            serversToRemove.push("desktop-commander");
        }

        if (serversToRemove.length === 0) {
            logToFile('Desktop Commander MCP server not found in configuration.');
            logToFile('✅ Desktop Commander was not configured or already removed.');
            return true;
        }

        // Remove the server configurations
        serversToRemove.forEach(serverName => {
            delete config.mcpServers[serverName];
            logToFile(`Removed "${serverName}" from Claude configuration`);
        });

        // Write the updated config back
        try {
            writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2), 'utf8');
            logToFile('✅ Desktop Commander successfully removed from Claude configuration');
            logToFile(`Configuration updated at: ${claudeConfigPath}`);
        } catch (writeError) {
            if (backupPath) {
                logToFile('Attempting to restore configuration from backup...');
                restoreFromBackup(backupPath);
            }
            throw new Error(`Failed to write updated config: ${writeError.message}`);
        }

        return true;
    } catch (error) {
        logToFile(`Error removing Desktop Commander configuration: ${error.message}`, true);
        if (backupPath) {
            logToFile('Attempting to restore configuration from backup...');
            restoreFromBackup(backupPath);
        }
        return false;
    }
}

// Main uninstall function
export default async function uninstall() {
    try {
        logToFile('Starting Desktop Commander uninstallation...');

        const configRemoved = removeDesktopCommanderConfig();

        if (configRemoved) {
            logToFile(`\n✅ Desktop Commander has been successfully uninstalled!`);
            logToFile('The MCP server has been removed from Claude\'s configuration.');
            logToFile('\nIf you want to reinstall later, you can run:');
            logToFile('npx @wonderwhy-er/desktop-commander@latest setup');
            logToFile('\nThank you for using Desktop Commander!\n');
            return true;
        } else {
            logToFile('\n❌ Uninstallation completed with errors.');
            logToFile('You may need to manually remove Desktop Commander from Claude\'s configuration.');
            logToFile(`Configuration file location: ${claudeConfigPath}\n`);
            return false;
        }
    } catch (error) {
        logToFile(`Fatal error during uninstallation: ${error.message}`, true);
        logToFile('\n❌ Uninstallation failed.');
        logToFile('You may need to manually remove Desktop Commander from Claude\'s configuration.');
        logToFile(`Configuration file location: ${claudeConfigPath}\n`);
        return false;
    }
}

// Allow direct execution
if (process.argv.length >= 2 && process.argv[1] === fileURLToPath(import.meta.url)) {
    uninstall().then(success => {
        if (!success) {
            process.exit(1);
        }
    }).catch(error => {
        logToFile(`Fatal error: ${error}`, true);
        process.exit(1);
    });
}
