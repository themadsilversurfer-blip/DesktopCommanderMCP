import { homedir, platform } from 'os';
import fs from 'fs/promises';
import path from 'path';
import { join } from 'path';
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { exec } from "node:child_process";
import { randomUUID } from 'crypto';

// Fix for Windows ESM path resolution
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Setup logging early to capture everything
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

/**
 * Initialize configuration - load from disk or create default
 */
async function initConfigFile() {
    const USER_HOME = homedir();
    const CONFIG_DIR = path.join(USER_HOME, '.claude-server-commander');
    const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

    try {
        const configDir = path.dirname(CONFIG_FILE);
        if (!existsSync(configDir)) {
            mkdirSync(configDir, { recursive: true });
        }

        try {
            await fs.access(CONFIG_FILE);
        } catch (error) {
            const defaultConfig = {
                blockedCommands: [
                    "mkfs", "format", "mount", "umount", "fdisk", "dd", "parted", "diskpart",
                    "sudo", "su", "passwd", "adduser", "useradd", "usermod", "groupadd", "chsh", "visudo",
                    "shutdown", "reboot", "halt", "poweroff", "init",
                    "iptables", "firewall", "netsh",
                    "sfc", "bcdedit", "reg", "net", "sc", "runas", "cipher", "takeown"
                ],
                clientId: randomUUID(),
                defaultShell: platform() === 'win32' ? 'powershell.exe' : '/bin/sh',
                allowedDirectories: [],
                fileWriteLineLimit: 50,
                fileReadLineLimit: 1000
            };

            try {
                await fs.writeFile(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2), 'utf8');
            } catch (error) {
                console.error('Failed to save config:', error);
                throw error;
            }
        }
    } catch (error) {
        console.error('Failed to initialize config:', error);
    }
}

const getVersion = async () => {
    try {
        if (process.env.npm_package_version) {
            return process.env.npm_package_version;
        }

        const versionPath = join(__dirname, 'version.js');
        if (existsSync(versionPath)) {
            const { VERSION } = await import(versionPath);
            return VERSION;
        }

        const packageJsonPath = join(__dirname, 'package.json');
        if (existsSync(packageJsonPath)) {
            const packageJsonContent = readFileSync(packageJsonPath, 'utf8');
            const packageJson = JSON.parse(packageJsonContent);
            if (packageJson.version) {
                return packageJson.version;
            }
        }

        return 'unknown';
    } catch (error) {
        return 'unknown';
    }
};

// Function to get the package spec that was used to run this script
function getPackageSpec(versionArg = null) {
    if (versionArg) {
        return `@wonderwhy-er/desktop-commander@${versionArg}`;
    }

    const argv = process.argv;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.includes('@wonderwhy-er/desktop-commander')) {
            const match = arg.match(/(@wonderwhy-er\/desktop-commander(@[^\/\s]+)?)/);
            if (match) {
                return match[1];
            }
        }
    }

    return '@wonderwhy-er/desktop-commander@latest';
}

function isNPX() {
    return process.env.npm_lifecycle_event === 'npx' ||
        process.env.npm_execpath?.includes('npx') ||
        process.env._?.includes('npx') ||
        import.meta.url.includes('node_modules');
}

// Function to check for debug mode argument
function isDebugMode() {
    return process.argv.includes('--debug');
}

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

async function restartClaude() {
    try {
        const platform = process.platform;

        // Try to kill Claude process first
        try {
            switch (platform) {
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
        } catch (killError) {
            // It's okay if Claude isn't running
        }

        // Wait a bit to ensure process termination
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Try to start Claude
        try {
            if (platform === "win32") {
                logToFile("Windows: Claude restart skipped - requires manual restart");
            } else if (platform === "darwin") {
                await execAsync(`open -a "Claude"`);
                logToFile("\n✅ Claude has been restarted automatically!");
            } else if (platform === "linux") {
                await execAsync(`claude`);
                logToFile("\n✅ Claude has been restarted automatically!");
            } else {
                logToFile('\nTo use the server restart Claude if it\'s currently running\n');
            }

            logToFile("\n✅ Installation successfully completed! Thank you for using Desktop Commander!\n");
            logToFile('\nThe server is available as "desktop-commander" in Claude\'s MCP server list');
            logToFile("Future updates will install automatically — no need to run this setup again.\n\n");
            logToFile("🤔 Need help or have feedback? Join our community: https://discord.com/invite/kQ27sNnZr7\n\n");
        } catch (startError) {
            throw startError;
        }
    } catch (error) {
        logToFile(`Failed to restart Claude: ${error}. Please restart it manually.`, true);
        logToFile(`If Claude Desktop is not installed use this link to download https://claude.ai/download`, true);
    }
}

// Main function to export for ESM compatibility
export default async function setup() {
    const versionArg = process.argv[3];
    const debugMode = isDebugMode();

    // Print ASCII art for DESKTOP COMMANDER
    console.log('\n');
    console.log('██████╗ ███████╗███████╗██╗  ██╗████████╗ ██████╗ ██████╗     ██████╗ ██████╗ ███╗   ███╗███╗   ███╗ █████╗ ███╗   ██╗██████╗ ███████╗██████╗ ');
    console.log('██╔══██╗██╔════╝██╔════╝██║ ██╔╝╚══██╔══╝██╔═══██╗██╔══██╗   ██╔════╝██╔═══██╗████╗ ████║████╗ ████║██╔══██╗████╗  ██║██╔══██╗██╔════╝██╔══██╗');
    console.log('██║  ██║█████╗  ███████╗█████╔╝    ██║   ██║   ██║██████╔╝   ██║     ██║   ██║██╔████╔██║██╔████╔██║███████║██╔██╗ ██║██║  ██║█████╗  ██████╔╝');
    console.log('██║  ██║██╔══╝  ╚════██║██╔═██╗    ██║   ██║   ██║██╔═══╝    ██║     ██║   ██║██║╚██╔╝██║██║╚██╔╝██║██╔══██║██║╚██╗██║██║  ██║██╔══╝  ██╔══██╗');
    console.log('██████╔╝███████╗███████║██║  ██╗   ██║   ╚██████╔╝██║        ╚██████╗╚██████╔╝██║ ╚═╝ ██║██║ ╚═╝ ██║██║  ██║██║ ╚████║██████╔╝███████╗██║  ██║');
    console.log('╚═════╝ ╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝         ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═════╝ ╚══════╝╚═╝  ╚═╝');
    console.log('\n');

    if (debugMode) {
        logToFile('Debug mode enabled. Will configure with Node.js inspector options.');
    }

    try {
        await initConfigFile();
        const configDir = dirname(claudeConfigPath);

        if (!existsSync(configDir)) {
            logToFile(`Creating config directory: ${configDir}`);
            mkdirSync(configDir, { recursive: true });
        }

        let config;

        if (!existsSync(claudeConfigPath)) {
            logToFile(`Claude config file not found at: ${claudeConfigPath}`);
            logToFile('Creating default config file...');

            const defaultConfig = {
                "serverConfig": isWindows
                    ? { "command": "cmd.exe", "args": ["/c"] }
                    : { "command": "/bin/sh", "args": ["-c"] }
            };

            writeFileSync(claudeConfigPath, JSON.stringify(defaultConfig, null, 2));
            logToFile('Default config file created.');
            config = defaultConfig;
        } else {
            const configData = readFileSync(claudeConfigPath, 'utf8');
            config = JSON.parse(configData);
        }

        // Determine if running through npx or locally
        const isNpx = isNPX();
        let serverConfig;

        if (debugMode) {
            if (isNpx) {
                logToFile('Setting up debug configuration with npx.');
                const debugEnv = {
                    "NODE_OPTIONS": "--inspect-brk=9229 --trace-warnings --trace-exit",
                    "DEBUG": "*"
                };
                const packageSpec = getPackageSpec(versionArg);

                if (isWindows) {
                    serverConfig = { "command": "cmd", "args": ["/c", "npx", packageSpec], "env": debugEnv };
                } else {
                    serverConfig = { "command": "npx", "args": [packageSpec], "env": debugEnv };
                }
            } else {
                const indexPath = join(__dirname, 'dist', 'index.js');
                logToFile('Setting up debug configuration with local path.');
                const debugEnv = {
                    "NODE_OPTIONS": "--trace-warnings --trace-exit",
                    "DEBUG": "*"
                };
                serverConfig = {
                    "command": isWindows ? "node.exe" : "node",
                    "args": ["--inspect-brk=9229", indexPath.replace(/\\/g, '\\\\')],
                    "env": debugEnv
                };
            }
        } else {
            if (isNpx) {
                const packageSpec = getPackageSpec(versionArg);
                if (isWindows) {
                    serverConfig = { "command": "cmd", "args": ["/c", "npx", "-y", packageSpec] };
                } else {
                    serverConfig = { "command": "npx", "args": ["-y", packageSpec] };
                }
            } else {
                const indexPath = join(__dirname, 'dist', 'index.js');
                serverConfig = { "command": "node", "args": [indexPath.replace(/\\/g, '\\\\')] };
            }
        }

        // Update the config
        if (!config.mcpServers) {
            config.mcpServers = {};
        }

        if (config.mcpServers.desktopCommander) {
            delete config.mcpServers.desktopCommander;
        }

        config.mcpServers["desktop-commander"] = serverConfig;
        writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2), 'utf8');

        const appVersion = await getVersion();
        logToFile(`✅ Desktop Commander MCP v${appVersion} successfully added to Claude's configuration.`);
        logToFile(`Configuration location: ${claudeConfigPath}`);

        if (debugMode) {
            logToFile('\nTo use the debug server:\n1. Restart Claude if it\'s currently running\n2. The server will be available as "desktop-commander-debug" in Claude\'s MCP server list\n3. Connect your debugger to port 9229');
        }

        await restartClaude();
        return true;
    } catch (error) {
        logToFile(`Error updating Claude configuration: ${error}`, true);
        return false;
    }
}

// Allow direct execution
if (process.argv.length >= 2 && process.argv[1] === fileURLToPath(import.meta.url)) {
    setup().then(success => {
        if (!success) {
            process.exit(1);
        }
    }).catch(error => {
        logToFile(`Fatal error: ${error}`, true);
        process.exit(1);
    });
}
