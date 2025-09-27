const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const os = require('os');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const SerialPort = require('serialport');
const logger = require('../utils/logger');

const tempDir = path.join(__dirname, '..', 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

// Configurable limits
const MAX_JOB_DOWNLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const DOWNLOAD_TIMEOUT_MS = 30_000;

const jobQueue = [];
let isPrinting = false;

// helper to run shell command with more robust error info
async function runCommand(cmd) {
  try {
    const { stdout, stderr } = await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 });
    if (stderr && stderr.trim()) {
      // Some commands write warnings to stderr but still succeed; include it in returned output
      return `${stdout?.trim()}\n(STDERR) ${stderr.trim()}`;
    }
    return stdout?.trim();
  } catch (err) {
    // err has stdout/stderr on some platforms
    const msg = (err.stderr || err.stdout || err.message || String(err)).toString();
    throw new Error(msg);
  }
}

// download with size and timeout checks; writes to tmp file
async function downloadToTemp(url, jobId) {
  const parsed = new URL(url);
  const ext = path.extname(parsed.pathname) || '.pdf';
  const fileName = `download_${jobId}${ext}`;
  const tmpPath = path.join(tempDir, fileName);

  const response = await axios({
    method: 'GET',
    url,
    responseType: 'stream',
    timeout: DOWNLOAD_TIMEOUT_MS,
    maxContentLength: MAX_JOB_DOWNLOAD_BYTES + 1,
    validateStatus: s => s >= 200 && s < 400
  });

  // check content-length if provided
  const contentLength = response.headers['content-length'];
  if (contentLength && Number(contentLength) > MAX_JOB_DOWNLOAD_BYTES) {
    response.data.destroy();
    throw new Error('File too large');
  }

  let downloaded = 0;
  const writer = fs.createWriteStream(tmpPath);
  return new Promise((resolve, reject) => {
    response.data.on('data', chunk => {
      downloaded += chunk.length;
      if (downloaded > MAX_JOB_DOWNLOAD_BYTES) {
        writer.destroy();
        response.data.destroy();
        reject(new Error('Downloaded file exceeds allowed maximum'));
      }
    });
    response.data.pipe(writer);
    writer.on('finish', () => resolve(tmpPath));
    writer.on('error', reject);
    response.data.on('error', reject);
  });
}

async function getPrinters() {
  const platform = os.platform();
  if (platform === 'win32') {
    // Use PowerShell to emit JSON (more reliable than wmic parsing)
    try {
      const psCmd = `powershell -NoProfile -Command "Get-Printer | Select-Object Name,Default | ConvertTo-Json"`;
      const out = await runCommand(psCmd);
      const parsed = JSON.parse(out);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return arr.map(p => ({ name: p.Name, isDefault: !!p.Default }));
    } catch (err) {
      // fallback: try wmic parsing (best-effort)
      try {
        const out = await runCommand('wmic printer get name,default');
        return out.split('\n').slice(1).map(line => {
          const parts = line.trim().split(/\s{2,}/).filter(Boolean);
          // best-effort mapping
          const isDefault = parts.some(p => /true/i.test(p));
          const name = parts.find(p => !/true|false/i.test(p)) || '';
          return { name: name.trim(), isDefault };
        }).filter(x => x.name);
      } catch (e) {
        throw new Error('Failed to list printers on Windows: ' + e.message);
      }
    }
  } else {
    // Linux / macOS
    try {
      const namesOutput = await runCommand("lpstat -p | awk '{print $2}'");
      const defaultOutput = await runCommand("lpstat -d | awk '{print $NF}' || true");
      const defaultPrinter = (defaultOutput || '').trim();
      return namesOutput.split('\n').filter(Boolean).map(n => ({ name: n.trim(), isDefault: n.trim() === defaultPrinter }));
    } catch (err) {
      throw new Error('Failed to list printers on *nix: ' + err.message);
    }
  }
}

// set default printer (awaits command)
async function setDefaultPrinter(printerName) {
  const printers = await getPrinters();
  if (!printers.some(p => p.name === printerName)) {
    return { success: false, error: 'There is no printer with this name' };
  }
  const platform = os.platform();
  const command = platform === 'win32'
    ? `RUNDLL32 PRINTUI.DLL,PrintUIEntry /y /n "${printerName}"`
    : `lpoptions -d "${printerName}"`;
  await runCommand(command);
  return { success: true };
}

// low-level printer command invoker
async function doPrintCommand(printer, filePathOrData, job) {
  const platform = os.platform();
  if (typeof filePathOrData === 'string' && fs.existsSync(filePathOrData)) {
    // file-based printing
    if (platform === 'win32') {
      // Windows 'print' is limited — on many systems using PrintTo via powershell is more reliable.
      // Use PowerShell Start-Process -FilePath <file> -Verb Print -ArgumentList /... as best-effort
      const cmd = `powershell -NoProfile -Command "Start-Process -FilePath '${filePathOrData.replace(/'/g, "''")}' -Verb Print -PassThru | Out-Null"`;
      return await runCommand(cmd);
    } else {
      const cmd = `lp -d "${printer}" "${filePathOrData}"`;
      return await runCommand(cmd);
    }
  } else if (Buffer.isBuffer(filePathOrData) || typeof filePathOrData === 'object') {
    // raw/binary printing (write temp and use RAW print)
    const tmp = path.join(tempDir, `raw_${uuidv4()}.bin`);
    fs.writeFileSync(tmp, Buffer.isBuffer(filePathOrData) ? filePathOrData : filePathOrData.buffer || filePathOrData);
    try {
      if (platform === 'win32') {
        // Use print direct via PowerShell / external tool; fallback to printers API
        // We'll try using the print command for now:
        const cmd = `print /d:"${printer}" "${tmp}"`;
        return await runCommand(cmd);
      } else {
        const cmd = `lp -d "${printer}" "${tmp}"`;
        return await runCommand(cmd);
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
    }
  } else {
    throw new Error('Unsupported print input');
  }
}

// Serial / USB helpers (basic)
async function listSerialPorts() {
  // returns array of { path, manufacturer, serialNumber }
  return SerialPort.list();
}

async function sendToSerial(portPath, data, options = { baudRate: 9600 }) {
  return new Promise((resolve, reject) => {
    const port = new SerialPort(portPath, { ...options }, (err) => {
      if (err) return reject(err);
      port.write(data, (werr) => {
        if (werr) return reject(werr);
        port.drain(drainErr => {
          if (drainErr) return reject(drainErr);
          port.close(closeErr => {
            if (closeErr) return reject(closeErr);
            resolve(true);
          });
        });
      });
    });
  });
}

// job processing
async function processQueue() {
  if (isPrinting || jobQueue.length === 0) return;
  isPrinting = true;
  const job = jobQueue.shift();
  logger.info(`[Queue] Processing job ${job.id} for printer: ${job.printer} type:${job.type}`);

  let filePathToPrint = null;
  let tempFileCreated = false;
  try {
    // resolve source
    if (job.type === 'url') {
      filePathToPrint = await downloadToTemp(job.source, job.id);
      tempFileCreated = true;
    } else if (job.type === 'file') {
      // a path given by caller (should be absolute and already validated)
      filePathToPrint = job.source;
    } else if (job.type === 'base64' || job.type === 'raw') {
      // direct raw content (base64)
      const buf = Buffer.from(job.source, 'base64');
      // direct buffer printing via doPrintCommand handles binary path
      await doPrintCommand(job.printer, buf, job);
      job.status = 'done';
      logger.info(`[Queue] Job ${job.id} printed (raw base64).`);
      return;
    } else {
      throw new Error('Unsupported job type: ' + job.type);
    }

    // file print path
    if (!filePathToPrint || !fs.existsSync(filePathToPrint)) {
      throw new Error('File to print not found');
    }

    const res = await doPrintCommand(job.printer, filePathToPrint, job);
    job.status = 'done';
    logger.info(`[CLI] Print command executed for job ${job.id}. Output: ${res}`);
  } catch (error) {
    logger.error(`[Queue] Failed to process job ${job.id}:`, error.message);
    job.status = 'failed';
    job.error = error.message;
  } finally {
    if (tempFileCreated && filePathToPrint) {
      try { fs.unlinkSync(filePathToPrint); } catch (e) { /* ignore */ }
    }
    isPrinting = false;
    // continue processing
    setImmediate(processQueue);
  }
}

async function addJobToQueue(jobDetails) {
  // jobDetails = { printerName?, type: 'url'|'file'|'base64'|'raw', source }
  const { printerName, type, source, contentType, copies = 1 } = jobDetails;
  if (!['url','file','base64','raw'].includes(type)) throw new Error('Invalid job type');

  let targetPrinter = printerName;
  if (!targetPrinter) {
    const printers = await getPrinters();
    const defaultPrinter = printers.find(p => p.isDefault);
    if (!defaultPrinter) throw new Error('No default printer and no printer specified');
    targetPrinter = defaultPrinter.name;
  }

  const newJob = {
    id: uuidv4(),
    printer: targetPrinter,
    type,
    source,
    status: 'queued',
    createdAt: Date.now()
  };

  jobQueue.push(newJob);
  // kick off processing
  setImmediate(processQueue);
  return newJob;
}

function getQueueStatus() {
  // return a shallow copy to avoid external modification
  return { isPrinting, queueSize: jobQueue.length, jobs: jobQueue.slice() };
}

module.exports = {
  getPrinters,
  setDefaultPrinter,
  addJobToQueue,
  getQueueStatus,
  listSerialPorts,
  sendToSerial
};
