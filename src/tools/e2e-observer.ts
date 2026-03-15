import { ServerResult } from '../types.js';
import { E2EObserverArgsSchema } from './schemas.js';
import { spawn, execFile } from 'child_process';
import { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';

// ── Constants ──────────────────────────────────────────────────────────────

const CF_WORKERS = [
  // Critical execution path
  'orchestrator-worker',
  'ai-parser-v2',
  'prep-newtrade-worker',
  'open-trade-forwarder',
  'newtrade-worker',
  'trade-maintainer',
  'trade-manager-do',
  'exchange-balance-do',
  'telegram-router',
  // Verification & Ground Truth
  'bybit-verification-worker',
  // Balance monitoring
  'balance-worker',
];

const VM_PROCESSES = [
  { name: 'baileys-bridge', pm2Name: 'baileys-bridge' },
  { name: 'belovy-price-monitor', pm2Name: 'belovy-price-monitor' },
];

const DEFAULT_VM_HOST = '91.99.222.13';
const DEFAULT_VM_USER = 'root';
const LOG_DIR = path.join(os.homedir(), 'Projects', 'e2e-logs');
const MAX_LOG_LINES = 5000;
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL
  || 'https://orchestrator-worker.<your-subdomain>.workers.dev/process';
const SIGNAL_BROADCASTER_URL = process.env.SIGNAL_BROADCASTER_URL
  || '';

// ── Types ──────────────────────────────────────────────────────────────────

interface ProcessEntry {
  name: string;
  type: 'ssh' | 'wrangler';
  process: ChildProcess;
  pid: number;
}

interface SessionState {
  id: string;
  name: string;
  signalSource: string;
  logFile: string;
  metaFile: string;
  processes: ProcessEntry[];
  writeStream: fs.WriteStream;
  startTime: number;
  autoStopTimer?: ReturnType<typeof setTimeout>;
  vmHost: string;
  vmUser: string;
}

interface SessionMeta {
  id: string;
  name: string;
  signalSource: string;
  logFile: string;
  startTime: number;
  endTime?: number;
  status: 'running' | 'stopped';
  processCount: number;
  vmHost: string;
  sshConnected: boolean;
}

// ── State ──────────────────────────────────────────────────────────────────

const activeSessions = new Map<string, SessionState>();

// ── Helpers ────────────────────────────────────────────────────────────────

function sanitizeOutput(output: string): string {
  return output
    .replace(/\[SYSTEM INSTRUCTION\]/gi, '[BLOCKED]')
    .replace(/\[SYSTEM\s+MESSAGE\]/gi, '[BLOCKED]')
    .replace(/\[SYSTEM\]/gi, '[BLOCKED]')
    .replace(/\[INST\]/gi, '[BLOCKED]')
    .replace(/<INSTRUCTION>/gi, '&lt;BLOCKED&gt;')
    .replace(/<\/INSTRUCTION>/gi, '&lt;/BLOCKED&gt;')
    .replace(/<!--[\s\S]*?-->/g, '');
}

function generateSessionId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 6);
  return `e2e_${ts}_${rand}`;
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function attachLineRouter(
  proc: ChildProcess,
  sourceName: string,
  writeStream: fs.WriteStream
): void {
  const prefix = sourceName.toUpperCase();

  for (const stream of [proc.stdout, proc.stderr]) {
    if (!stream) continue;
    const rl = readline.createInterface({ input: stream });
    rl.on('line', (line) => {
      const sanitized = sanitizeOutput(line);
      writeStream.write(`[${formatTimestamp()}] [${prefix}] ${sanitized}\n`);
    });
  }
}

// ── SSH Connectivity Check ─────────────────────────────────────────────────

async function checkSshConnectivity(host: string, user: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = execFile('ssh', [
      '-o', 'ConnectTimeout=3',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      `${user}@${host}`,
      'echo ok',
    ], { timeout: 5000 }, (error, stdout) => {
      if (error) {
        resolve({
          ok: false,
          error: `SSH to ${user}@${host} failed: ${error.message}`,
        });
      } else if (stdout.trim() === 'ok') {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, error: `SSH to ${user}@${host}: unexpected response` });
      }
    });

    child.on('error', (err) => {
      resolve({ ok: false, error: `SSH spawn failed: ${err.message}` });
    });
  });
}

// ── Mode 1: start_observation ──────────────────────────────────────────────

async function startObservation(args: {
  session_name?: string;
  signal_source?: string;
  vm_host?: string;
  vm_user?: string;
  duration_seconds?: number;
}): Promise<ServerResult> {
  const sessionName = args.session_name || 'unnamed';
  const signalSource = args.signal_source || 'manual';
  const vmHost = args.vm_host || DEFAULT_VM_HOST;
  const vmUser = args.vm_user || DEFAULT_VM_USER;
  const durationSeconds = args.duration_seconds || 300; // 5 min default

  // Ensure log directory exists
  await fsp.mkdir(LOG_DIR, { recursive: true });

  const sessionId = generateSessionId();
  const logFileName = `${sessionName}_${sessionId}.log`;
  const logFile = path.join(LOG_DIR, logFileName);
  const metaFile = path.join(LOG_DIR, `${sessionId}.meta.json`);

  // Open write stream
  const writeStream = fs.createWriteStream(logFile, { flags: 'a' });
  writeStream.write(`[${formatTimestamp()}] [OBSERVER] Session "${sessionName}" started (source: ${signalSource})\n`);

  const processes: ProcessEntry[] = [];
  let sshConnected = false;

  // Check SSH connectivity before spawning VM processes
  const sshCheck = await checkSshConnectivity(vmHost, vmUser);

  if (sshCheck.ok) {
    sshConnected = true;
    writeStream.write(`[${formatTimestamp()}] [OBSERVER] SSH connectivity to ${vmUser}@${vmHost}: OK\n`);

    // Spawn SSH processes for VM monitoring
    for (const vmProc of VM_PROCESSES) {
      try {
        const sshProc = spawn('ssh', [
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'ConnectTimeout=5',
          '-o', 'BatchMode=yes',
          `${vmUser}@${vmHost}`,
          `pm2 logs ${vmProc.pm2Name} --lines 0 --raw --nostream=false`,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        attachLineRouter(sshProc, vmProc.name, writeStream);

        sshProc.on('error', (err) => {
          writeStream.write(`[${formatTimestamp()}] [${vmProc.name.toUpperCase()}] SPAWN-ERROR: ${err.message}\n`);
        });

        sshProc.on('close', (code) => {
          writeStream.write(`[${formatTimestamp()}] [${vmProc.name.toUpperCase()}] EXITED (code: ${code})\n`);
        });

        if (sshProc.pid) {
          processes.push({
            name: vmProc.name,
            type: 'ssh',
            process: sshProc,
            pid: sshProc.pid,
          });
        }
      } catch (err) {
        writeStream.write(`[${formatTimestamp()}] [${vmProc.name.toUpperCase()}] SPAWN-ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  } else {
    writeStream.write(`[${formatTimestamp()}] [OBSERVER] SSH connectivity FAILED: ${sshCheck.error}\n`);
    writeStream.write(`[${formatTimestamp()}] [OBSERVER] Continuing with CF Workers only (VM processes skipped)\n`);
  }

  // Check wrangler authentication before spawning
  let wranglerAuthenticated = true;
  try {
    const wranglerAuth = await new Promise<boolean>((resolve) => {
      execFile('npx', ['wrangler', 'whoami'], { timeout: 10000 }, (error, stdout, stderr) => {
        const output = (stdout || '') + (stderr || '');
        if (error || /not authenticated/i.test(output)) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
    wranglerAuthenticated = wranglerAuth;
  } catch {
    wranglerAuthenticated = false;
  }

  if (!wranglerAuthenticated) {
    writeStream.write(`[${formatTimestamp()}] [OBSERVER] Wrangler auth check FAILED - BLOCKING start\n`);
    writeStream.end();
    return {
      content: [{
        type: 'text',
        text: `Error: Wrangler not authenticated.\n\n` +
          `E2E observation requires ALL components — partial observation is not acceptable.\n` +
          `Run 'npx wrangler login' in your terminal first, then retry start_observation.\n\n` +
          `Command: npx wrangler login`,
      }],
      isError: true,
    };
  }

  // Spawn wrangler tail for each CF Worker
  for (const workerName of CF_WORKERS) {
    try {
      const wranglerProc = spawn('npx', [
        'wrangler', 'tail', workerName, '--format', 'json',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      attachLineRouter(wranglerProc, workerName, writeStream);

      wranglerProc.on('error', (err) => {
        writeStream.write(`[${formatTimestamp()}] [${workerName.toUpperCase()}] SPAWN-ERROR: ${err.message}\n`);
      });

      wranglerProc.on('close', (code) => {
        writeStream.write(`[${formatTimestamp()}] [${workerName.toUpperCase()}] EXITED (code: ${code})\n`);
      });

      if (wranglerProc.pid) {
        processes.push({
          name: workerName,
          type: 'wrangler',
          process: wranglerProc,
          pid: wranglerProc.pid,
        });
      }
    } catch (err) {
      writeStream.write(`[${formatTimestamp()}] [${workerName.toUpperCase()}] SPAWN-ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // Set up auto-stop timer
  const autoStopTimer = setTimeout(async () => {
    if (activeSessions.has(sessionId)) {
      await stopSessionInternal(sessionId, 'auto-timeout');
    }
  }, durationSeconds * 1000);

  // Create session state
  const session: SessionState = {
    id: sessionId,
    name: sessionName,
    signalSource: signalSource,
    logFile,
    metaFile,
    processes,
    writeStream,
    startTime: Date.now(),
    autoStopTimer,
    vmHost,
    vmUser,
  };

  activeSessions.set(sessionId, session);

  // Write metadata
  const meta: SessionMeta = {
    id: sessionId,
    name: sessionName,
    signalSource,
    logFile,
    startTime: session.startTime,
    status: 'running',
    processCount: processes.length,
    vmHost,
    sshConnected,
  };
  await fsp.writeFile(metaFile, JSON.stringify(meta, null, 2));

  const sshStatus = sshConnected
    ? `SSH: connected (${VM_PROCESSES.length} VM processes)`
    : `SSH: FAILED - ${sshCheck.error}\nTip: Ensure SSH key is at ~/.ssh/id_rsa and host ${vmHost} is reachable`;

  const pidList = processes.map(p => `  ${p.name} (${p.type}): PID ${p.pid}`).join('\n');

  return {
    content: [{
      type: 'text',
      text: `E2E Observation Started\n` +
        `Session: ${sessionId}\n` +
        `Name: ${sessionName}\n` +
        `Source: ${signalSource}\n` +
        `Duration: ${durationSeconds}s (auto-stop)\n` +
        `Log: ${logFile}\n` +
        `${sshStatus}\n` +
        `Workers: ${CF_WORKERS.length} CF Workers tailing\n` +
        `Total processes: ${processes.length}\n\n` +
        `PIDs:\n${pidList}`,
    }],
  };
}

// ── Mode 2: stop_observation ───────────────────────────────────────────────

async function stopSessionInternal(sessionId: string, reason: string = 'manual'): Promise<{ killed: number; logSize: number }> {
  const session = activeSessions.get(sessionId);
  if (!session) return { killed: 0, logSize: 0 };

  // Clear auto-stop timer
  if (session.autoStopTimer) {
    clearTimeout(session.autoStopTimer);
  }

  session.writeStream.write(`[${formatTimestamp()}] [OBSERVER] Stopping session (reason: ${reason})\n`);

  let killed = 0;

  // SIGTERM all processes
  for (const entry of session.processes) {
    try {
      entry.process.kill('SIGTERM');
    } catch { /* already dead */ }
  }

  // Wait 2s then SIGKILL stragglers
  await new Promise(resolve => setTimeout(resolve, 2000));

  for (const entry of session.processes) {
    try {
      if (!entry.process.killed) {
        entry.process.kill('SIGKILL');
      }
      killed++;
    } catch { /* already dead */ }
  }

  session.writeStream.write(`[${formatTimestamp()}] [OBSERVER] Session stopped. ${killed} processes terminated.\n`);
  session.writeStream.end();

  // Get log file size
  let logSize = 0;
  try {
    const stat = await fsp.stat(session.logFile);
    logSize = stat.size;
  } catch { /* file might not exist */ }

  // Update metadata
  try {
    const meta: SessionMeta = JSON.parse(await fsp.readFile(session.metaFile, 'utf-8'));
    meta.status = 'stopped';
    meta.endTime = Date.now();
    await fsp.writeFile(session.metaFile, JSON.stringify(meta, null, 2));
  } catch { /* metadata write failure is non-fatal */ }

  activeSessions.delete(sessionId);
  return { killed, logSize };
}

async function stopObservation(args: { session_id: string }): Promise<ServerResult> {
  const { session_id } = args;

  if (!activeSessions.has(session_id)) {
    return {
      content: [{ type: 'text', text: `Error: No active session with ID "${session_id}". Use mode 'list_sessions' to see available sessions.` }],
      isError: true,
    };
  }

  const session = activeSessions.get(session_id)!;
  const durationSec = Math.round((Date.now() - session.startTime) / 1000);
  const { killed, logSize } = await stopSessionInternal(session_id, 'manual');

  const logSizeKB = (logSize / 1024).toFixed(1);

  return {
    content: [{
      type: 'text',
      text: `E2E Observation Stopped\n` +
        `Session: ${session_id}\n` +
        `Duration: ${durationSec}s\n` +
        `Processes killed: ${killed}\n` +
        `Log size: ${logSizeKB} KB\n` +
        `Log file: ${session.logFile}`,
    }],
  };
}

// ── Mode 3: get_log_summary ────────────────────────────────────────────────

async function getLogSummary(args: { session_id: string; filter?: string }): Promise<ServerResult> {
  const { session_id, filter = 'all' } = args;

  // Find log file - check active sessions first, then metadata files
  let logFile: string | null = null;

  const activeSession = activeSessions.get(session_id);
  if (activeSession) {
    logFile = activeSession.logFile;
  } else {
    // Check metadata files
    const metaFile = path.join(LOG_DIR, `${session_id}.meta.json`);
    try {
      const meta: SessionMeta = JSON.parse(await fsp.readFile(metaFile, 'utf-8'));
      logFile = meta.logFile;
    } catch {
      return {
        content: [{ type: 'text', text: `Error: No session found with ID "${session_id}".` }],
        isError: true,
      };
    }
  }

  // Read log file
  let content: string;
  try {
    content = await fsp.readFile(logFile!, 'utf-8');
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: Could not read log file: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }

  let lines = content.split('\n');

  // Apply filter FIRST (before cap)
  if (filter === 'errors_only') {
    lines = lines.filter(l =>
      /error|fail|exception|reject|timeout|SPAWN-ERROR/i.test(l)
    );
  } else if (filter === 'trade_flow') {
    lines = lines.filter(l =>
      /trade|order|position|signal|parse|pipeline|newtrade|orchestrat|bybit/i.test(l)
    );
  }
  // 'all' = no filter

  // THEN cap at MAX_LOG_LINES
  const totalFiltered = lines.length;
  let truncated = false;
  if (lines.length > MAX_LOG_LINES) {
    lines = lines.slice(-MAX_LOG_LINES); // Keep the LAST N lines (most recent)
    truncated = true;
  }

  const sanitized = sanitizeOutput(lines.join('\n'));

  const header = `Log Summary for ${session_id} (filter: ${filter})\n` +
    `Total lines after filter: ${totalFiltered}` +
    (truncated ? ` (showing last ${MAX_LOG_LINES})` : '') +
    `\nLog file: ${logFile}\n` +
    `---\n`;

  return {
    content: [{ type: 'text', text: header + sanitized }],
  };
}

// ── Mode 4: list_sessions ──────────────────────────────────────────────────

async function listSessions(): Promise<ServerResult> {
  // Ensure log directory exists
  try {
    await fsp.mkdir(LOG_DIR, { recursive: true });
  } catch { /* ignore */ }

  let metaFiles: string[];
  try {
    const files = await fsp.readdir(LOG_DIR);
    metaFiles = files.filter(f => f.endsWith('.meta.json'));
  } catch {
    return {
      content: [{ type: 'text', text: 'No sessions found. Log directory does not exist yet.' }],
    };
  }

  if (metaFiles.length === 0) {
    return {
      content: [{ type: 'text', text: 'No sessions found.' }],
    };
  }

  const sessions: SessionMeta[] = [];
  for (const file of metaFiles) {
    try {
      const content = await fsp.readFile(path.join(LOG_DIR, file), 'utf-8');
      sessions.push(JSON.parse(content));
    } catch { /* skip corrupt metadata */ }
  }

  // Sort by start time descending
  sessions.sort((a, b) => b.startTime - a.startTime);

  let output = `E2E Observer Sessions (${sessions.length} total)\n`;
  output += `${'ID'.padEnd(22)} ${'Name'.padEnd(15)} ${'Status'.padEnd(10)} ${'Procs'.padEnd(6)} ${'SSH'.padEnd(5)} Duration\n`;
  output += '-'.repeat(80) + '\n';

  for (const s of sessions) {
    const isActive = activeSessions.has(s.id);
    const status = isActive ? 'RUNNING' : s.status;
    const duration = s.endTime
      ? `${Math.round((s.endTime - s.startTime) / 1000)}s`
      : isActive
        ? `${Math.round((Date.now() - s.startTime) / 1000)}s (live)`
        : 'unknown';
    const ssh = s.sshConnected ? 'yes' : 'no';

    // Get log file size
    let sizeStr = '';
    try {
      const stat = await fsp.stat(s.logFile);
      sizeStr = ` (${(stat.size / 1024).toFixed(1)} KB)`;
    } catch { /* file gone */ }

    output += `${s.id.padEnd(22)} ${s.name.padEnd(15)} ${status.padEnd(10)} ${String(s.processCount).padEnd(6)} ${ssh.padEnd(5)} ${duration}${sizeStr}\n`;
  }

  return {
    content: [{ type: 'text', text: output }],
  };
}

// ── Mode 5: trigger_test_signal ────────────────────────────────────────────

async function triggerTestSignal(args: {
  trigger_method: string;
  signal_payload?: string;
}): Promise<ServerResult> {
  const { trigger_method, signal_payload } = args;

  const defaultPayload = {
    alarm_signal: true,
    signal_data: {
      message_type: 'info_only',
      message: 'E2E test signal from Desktop Commander Observer',
      timestamp: new Date().toISOString(),
      source: 'e2e_observer',
    },
  };

  let payload: any;
  if (signal_payload) {
    try {
      payload = JSON.parse(signal_payload);
    } catch {
      return {
        content: [{ type: 'text', text: 'Error: signal_payload must be valid JSON.' }],
        isError: true,
      };
    }
  } else {
    payload = defaultPayload;
  }

  let targetUrl: string;

  if (trigger_method === 'direct_post') {
    targetUrl = ORCHESTRATOR_URL;
  } else if (trigger_method === 'signal_broadcaster') {
    targetUrl = SIGNAL_BROADCASTER_URL || ORCHESTRATOR_URL;
  } else {
    return {
      content: [{ type: 'text', text: `Error: Unknown trigger_method "${trigger_method}".` }],
      isError: true,
    };
  }

  if (targetUrl.includes('<your-subdomain>')) {
    return {
      content: [{
        type: 'text',
        text: `Error: ORCHESTRATOR_URL not configured.\n` +
          `Set the ORCHESTRATOR_URL environment variable first.\n` +
          `Find it with: wrangler deployments list --name orchestrator-worker`,
      }],
      isError: true,
    };
  }

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    let responseData: any;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }

    const sanitizedResponse = sanitizeOutput(
      typeof responseData === 'string' ? responseData : JSON.stringify(responseData, null, 2)
    );

    if (response.ok) {
      return {
        content: [{
          type: 'text',
          text: `Test Signal Sent Successfully\n` +
            `Method: ${trigger_method}\n` +
            `URL: ${targetUrl}\n` +
            `Status: ${response.status} ${response.statusText}\n` +
            `Payload sent:\n${JSON.stringify(payload, null, 2)}\n\n` +
            `Response:\n${sanitizedResponse}`,
        }],
      };
    } else {
      return {
        content: [{
          type: 'text',
          text: `Test Signal Failed\n` +
            `Method: ${trigger_method}\n` +
            `URL: ${targetUrl}\n` +
            `Status: ${response.status} ${response.statusText}\n` +
            `Response:\n${sanitizedResponse}`,
        }],
        isError: true,
      };
    }
  } catch (err) {
    return {
      content: [{
        type: 'text',
        text: `Error sending test signal: ${err instanceof Error ? err.message : String(err)}\n` +
          `URL: ${targetUrl}\n` +
          `Tip: Ensure the worker is deployed and accessible.`,
      }],
      isError: true,
    };
  }
}

// ── Main Export ─────────────────────────────────────────────────────────────

export async function e2eObserver(args: unknown): Promise<ServerResult> {
  const parsed = E2EObserverArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{
        type: 'text',
        text: `Invalid arguments: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
      }],
      isError: true,
    };
  }

  const { mode } = parsed.data;

  switch (mode) {
    case 'start_observation':
      return startObservation(parsed.data);
    case 'stop_observation':
      return stopObservation({ session_id: parsed.data.session_id! });
    case 'get_log_summary':
      return getLogSummary({ session_id: parsed.data.session_id!, filter: parsed.data.filter });
    case 'list_sessions':
      return listSessions();
    case 'trigger_test_signal':
      return triggerTestSignal({
        trigger_method: parsed.data.trigger_method!,
        signal_payload: parsed.data.signal_payload,
      });
    default:
      return {
        content: [{ type: 'text', text: `Unknown mode: ${mode}` }],
        isError: true,
      };
  }
}
