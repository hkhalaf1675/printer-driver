const { print: pdfPrint } = require('pdf-to-printer');
const axios = require('axios');
const tmp = require('tmp-promise');
const fs = require('fs-extra');
const path = require('path');
const BetterQueue = require('better-queue');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const SerialPort = require('serialport');
const escpos = require('escpos');
escpos.USB = require('escpos-usb');
// `usb` module used to enumerate USB devices for discovery
let usbLib;
try { usbLib = require('usb'); } catch (e) { usbLib = null; }

const DEFAULT_CONCURRENCY = 1;

class PrinterService {
  constructor(opts = {}) {
    this.queue = new BetterQueue(
      async (job, cb) => {
        try {
          const res = await this._processJob(job);
          cb(null, res);
        } catch (err) {
          cb(err);
        }
      },
      {
        concurrent: opts.concurrent || DEFAULT_CONCURRENCY,
        retryDelay: 2000,
        maxRetries: 2,
      }
    );

    this.jobs = new Map(); // jobId -> metadata
  }

  // -------------------- Public API --------------------
  async getPrinters() {
    const system = await this._listSystemPrinters();
    const serial = await this._listSerialPorts();
    const usb = this._listUsbDevices();
    return { system, serial, usb };
  }

  // async setDefaultPrinter(name) {
  //   const platform = os.platform();
  //   const command = platform === 'win32'
  //       ? `RUNDLL32 PRINTUI.DLL,PrintUIEntry /y /n "${name}"`
  //       : `lpoptions -d "${name}"`;
  //   try {
  //     return this._runCommand(command).then(() => ({ ok: true }));
  //   } catch (error) {
  //     return { ok: false  }
  //   }
  // }

  async setDefaultPrinter(name) {
    if (!name) throw new Error('Printer name required');

    if (process.platform === 'win32') {
      // use rundll32 PrintUIEntry (non-interactive)
      // /y = set as default, /n = printer name
      // escape double quotes and backslashes
      const safeName = name.replace(/"/g, '\\"');
      const cmd = `rundll32 printui.dll,PrintUIEntry /y /n "${safeName}"`;

      try {
        await this._execPromise(cmd, { timeoutMs: 10000 });
        return { ok: true };
      } catch (err) {
        // include actionable info
        throw new Error(`Failed to set default printer: ${String(err)}. Double-check printer name and connectivity.`);
      }
    } else {
      // linux/mac fallback (lpoptions)
      const safeName = name.replace(/"/g, '\\"');
      const cmd = `lpoptions -d "${safeName}"`;
      try {
        await this._execPromise(cmd, { timeoutMs: 10000 });
        return { ok: true };
      } catch (err) {
        throw new Error(`Failed to set default printer (lpoptions): ${String(err)}`);
      }
    }
  }

  async getDefaultPrinter() {
    if (process.platform === 'win32') {
      const cmd = 'powershell -NoProfile -Command "Get-Printer | Where-Object {$_.Default -eq $true} | Select-Object -ExpandProperty Name"';
      return this._execPromise(cmd).then(s => (s || '').trim());
    } else {
      const cmd = `lpstat -d 2>/dev/null | awk -F': ' '{print $2}'`;
      return this._execPromise(cmd).then(s => (s || '').trim());
    }
  }

  /**
   * addJobToQueue(jobOptions)
   * jobOptions example:
   * {
   *   type: 'system'|'serial'|'escpos',
   *   printerName: 'Microsoft XPS Document Writer', // for system
   *   filePath: '/path/to/file.pdf',
   *   url: 'https://example.com/file.pdf',
   *   data: Buffer|string, // raw bytes or text
   *   serialOptions: { path: 'COM3', baudRate: 9600 },
   *   escposOptions: { device: { vendorId, productId } },
   *   copies: 1,
   *   metadata: {}
   * }
   */
  async addJobToQueue(jobOptions) {
    const jobId = uuidv4();
    const job = { id: jobId, options: jobOptions, createdAt: Date.now(), attempts: 0 };

    this.jobs.set(jobId, { state: 'queued', createdAt: Date.now(), meta: jobOptions });

    this.queue.push(job, (err, result) => {
      if (err) {
        const st = this.jobs.get(jobId) || {};
        st.state = 'failed';
        st.error = String(err);
        st.finishedAt = Date.now();
        this.jobs.set(jobId, st);
      } else {
        const st = this.jobs.get(jobId) || {};
        st.state = 'done';
        st.result = result;
        st.finishedAt = Date.now();
        this.jobs.set(jobId, st);
      }
    });

    return jobId;
  }

  async getQueueStatus({ statsTimeoutMs = 3000 } = {}) {
    // try to get better-queue stats, but don't wait forever
    const stats = await Promise.race([
      new Promise(resolve => {
        try {
          this.queue.getStats((err, s) => {
            if (err) return resolve(null);
            resolve(s);
          });
        } catch (e) {
          // if calling getStats throws synchronously, treat as unavailable
          resolve(null);
        }
      }),
      // timeout fallback
      new Promise(resolve => setTimeout(() => resolve(null), statsTimeoutMs))
    ]);

    // Build job list from in-memory store (guaranteed synchronous)
    const jobs = Array.from(this.jobs.entries()).map(([id, data]) => ({ id, ...data }));

    // also provide a small computed summary (counts) so the client can get useful info
    const counts = jobs.reduce((acc, job) => {
      const s = job.state || 'unknown';
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {});

    return { stats, counts, jobs };
  }

  // -------------------- Internal / helpers --------------------
  async _processJob(job) {
    const { id, options } = job;
    this.jobs.set(id, { state: 'running', startedAt: Date.now(), meta: options });

    let tmpFilePath = null;
    try {
      const { url, filePath, data } = options;
      let effectiveFile = filePath;
      let effectiveData = data;

      if (url) {
        const ext = path.extname(new URL(url).pathname) || '.tmp';
        const tmpobj = await tmp.file({ postfix: ext });
        tmpFilePath = tmpobj.path;
        await this._downloadToFile(url, tmpFilePath);
        effectiveFile = tmpFilePath;
      }

      const t = options.type || 'system';
      let result;
      if (t === 'system') {
        result = await this._printSystem({ printerName: options.printerName, filePath: effectiveFile, data: effectiveData, copies: options.copies });
      } else if (t === 'serial') {
        result = await this._printSerial({ serialOptions: options.serialOptions, data: effectiveData, filePath: effectiveFile });
      } else if (t === 'escpos') {
        result = await this._printEscpos({ escposOptions: options.escposOptions, data: effectiveData, filePath: effectiveFile });
      } else {
        throw new Error(`Unknown job type: ${t}`);
      }

      if (tmpFilePath) {
        try { await fs.unlink(tmpFilePath); } catch (e) {}
      }

      return result;
    } catch (err) {
      if (tmpFilePath) try { await fs.unlink(tmpFilePath); } catch (e) {}
      throw err;
    }
  }

  // -------------------- Backends --------------------
  // System printing: prefer pdf-to-printer for PDF, fallback to Start-Process -Verb Print for other files
  async _printSystem({ printerName, filePath, data, copies = 1 }) {
    let pathToPrint = filePath;
    let cleanup = null;

    // If data provided and looks like PDF, write it
    if (!pathToPrint && data) {
      if (Buffer.isBuffer(data) && data.slice(0,4).toString() === '%PDF') {
        const tmpf = await tmp.file({ postfix: '.pdf' });
        await fs.writeFile(tmpf.path, data);
        pathToPrint = tmpf.path;
        cleanup = tmpf.cleanup;
      } else if (typeof data === 'string') {
        // write to a text file and use shell printing for text
        const tmpf = await tmp.file({ postfix: '.txt' });
        await fs.writeFile(tmpf.path, data, 'utf8');
        pathToPrint = tmpf.path;
        cleanup = tmpf.cleanup;
      } else if (Buffer.isBuffer(data)) {
        // unknown binary: write as-is and attempt to print via shell
        const tmpf = await tmp.file({ postfix: path.extname(filePath) || '.bin' });
        await fs.writeFile(tmpf.path, data);
        pathToPrint = tmpf.path;
        cleanup = tmpf.cleanup;
      }
    }

    // If no file to print, error
    if (!pathToPrint) throw new Error('No filePath or printable data provided');

    // If PDF, use pdf-to-printer
    const ext = path.extname(pathToPrint).toLowerCase();
    if (ext === '.pdf') {
      const opts = {};
      if (printerName) opts.printer = printerName;
      if (copies && Number(copies) > 1) opts.copies = Number(copies);
      try {
        await pdfPrint(pathToPrint, opts);
        if (cleanup) await cleanup();
        return { ok: true, method: 'pdf-to-printer' };
      } catch (err) {
        if (cleanup) await cleanup();
        throw err;
      }
    }

    // For non-PDF: fallback to OS-level print (Start-Process -Verb Print on Windows)
    if (process.platform === 'win32') {
      // Use PowerShell Start-Process -Verb Print
      // If printerName is provided, we can't directly pass printer to Start-Process; it uses default printer of the application.
      // For more control, user should supply a PDF and we use pdf-to-printer.
      const safe = pathToPrint.replace(/'/g, "''");
      const cmd = `powershell -NoProfile -Command "Start-Process -FilePath '${safe}' -Verb Print -PassThru | Out-Null"`;
      await this._execPromise(cmd);
      if (cleanup) await cleanup();
      return { ok: true, method: 'start-process' };
    } else {
      // On linux/mac try lp
      const cmd = `lp "${pathToPrint.replace(/"/g, '\\"')}" ${printerName ? '-d ' + printerName : ''}`;
      await this._execPromise(cmd);
      if (cleanup) await cleanup();
      return { ok: true, method: 'lp' };
    }
  }

  // Serial printing (raw bytes)
  async _printSerial({ serialOptions = {}, data, filePath, encoding = 'utf8' }) {
    let payload;
    if (filePath) {
      payload = await fs.readFile(filePath);
    } else if (Buffer.isBuffer(data)) {
      payload = data;
    } else {
      payload = Buffer.from(String(data || ''), encoding);
    }

    if (!serialOptions || !serialOptions.path) throw new Error('serialOptions.path required');

    return await new Promise((resolve, reject) => {
      const port = new SerialPort(serialOptions.path, {
        baudRate: serialOptions.baudRate || 9600,
        autoOpen: false,
        parity: serialOptions.parity || 'none',
        dataBits: serialOptions.dataBits || 8,
        stopBits: serialOptions.stopBits || 1,
      });

      const timeout = serialOptions.timeout || 10000;
      let timer = setTimeout(() => {
        try { port.close(() => {}); } catch (e) {}
        reject(new Error('Serial write timeout'));
      }, timeout);

      port.open(err => {
        if (err) { clearTimeout(timer); return reject(err); }
        port.write(payload, writeErr => {
          if (writeErr) { clearTimeout(timer); try { port.close(() => {}); } catch (e) {} ; return reject(writeErr); }
          port.drain(drainErr => {
            clearTimeout(timer);
            port.close(() => {
              if (drainErr) return reject(drainErr);
              resolve({ ok: true });
            });
          });
        });
      });
    });
  }

  // ESC/POS printing via escpos (USB thermal)
  async _printEscpos({ escposOptions = {}, data, filePath }) {
    // Build device
    let device;
    if (escposOptions && escposOptions.device) {
      const d = escposOptions.device;
      // user can pass new escpos.USB(vendorId, productId) as device
      if (d.vendorId && d.productId) device = new escpos.USB(d.vendorId, d.productId);
      else device = d; // assume ready-to-use device
    } else {
      // default: pick first escpos USB device
      try {
        device = new escpos.USB();
      } catch (e) {
        throw new Error('Unable to create ESC/POS USB device: ' + e.message);
      }
    }

    const adapter = new escpos.Adapter(device);
    const printer = new escpos.Printer(adapter);

    const openAdapter = () => new Promise((resolve, reject) => adapter.open(err => err ? reject(err) : resolve()));
    const closeAdapter = () => new Promise((resolve) => adapter.close(() => resolve()));

    if (filePath) {
      const buffer = await fs.readFile(filePath);
      await openAdapter();
      await new Promise((resolve, reject) => {
        adapter.write(buffer, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
      await closeAdapter();
      return { ok: true };
    }

    if (Buffer.isBuffer(data)) {
      await openAdapter();
      await new Promise((resolve, reject) => {
        adapter.write(data, err => err ? reject(err) : resolve());
      });
      await closeAdapter();
      return { ok: true };
    }

    // otherwise treat data as text
    await openAdapter();
    await new Promise((resolve, reject) => {
      try {
        printer
          .text(String(data || ''))
          .cut()
          .close(() => resolve({ ok: true }));
      } catch (e) {
        reject(e);
      }
    });
  }

  // -------------------- Discovery helpers --------------------
  async _listSystemPrinters() {
    if (process.platform === 'win32') {
      const cmd = 'powershell -NoProfile -Command "Get-Printer | Select-Object Name, ShareName, PortName, Default | ConvertTo-Json -Compress"';
      try {
        const out = await this._execPromise(cmd);
        if (!out) return [];
        const parsed = JSON.parse(out);
        // parsed may be object or array
        if (Array.isArray(parsed)) return parsed;
        return [parsed];
      } catch (e) {
        return [];
      }
    } else {
      // linux / mac: use lpstat -p
      try {
        const out = await this._execPromise('lpstat -p');
        const lines = (out || '').split(/\r?\n/).filter(Boolean);
        // parse simple format: "printer <name> ..."
        const printers = lines.map(l => {
          const m = l.match(/^printer\s+(\S+)/i);
          return m ? { Name: m[1], Raw: l } : null;
        }).filter(Boolean);
        return printers;
      } catch (e) {
        return [];
      }
    }
  }

  async _listSerialPorts() {
    try {
      return await SerialPort.list();
    } catch (e) {
      return [];
    }
  }

  _listUsbDevices() {
    if (!usbLib) return [];
    try {
      return usbLib.getDeviceList().map(d => ({
        busNumber: d.busNumber,
        deviceAddress: d.deviceAddress,
        deviceDescriptor: d.deviceDescriptor || null,
      }));
    } catch (e) {
      return [];
    }
  }

  // -------------------- Utility helpers --------------------
  async _downloadToFile(url, destPath) {
    const res = await axios({ method: 'get', url, responseType: 'stream' });
    const writer = fs.createWriteStream(destPath);
    return new Promise((resolve, reject) => {
      res.data.pipe(writer);
      let error = null;
      writer.on('error', err => { error = err; writer.close(); reject(err); });
      writer.on('close', () => { if (!error) resolve(); });
    });
  }

  _execPromise(cmd, { timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      const child = exec(cmd, { shell: true }, (err, stdout, stderr) => {
        if (err) {
          // prefer stderr for error text
          const msg = stderr || stdout || err.message || String(err);
          return reject(new Error(msg));
        }
        resolve(stdout ? String(stdout) : '');
      });

      // safety: kill if hangs
      const to = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (e) {}
        reject(new Error(`Command timed out after ${timeoutMs} ms: ${cmd}`));
      }, timeoutMs);

      child.on('exit', () => clearTimeout(to));
    });
  }

  _runCommand = (cmd) => new Promise((resolve, reject) => {
      exec(cmd, (error, stdout, stderr) => {
          if (error) return reject(new Error(stderr || error.message));
          resolve(stdout.trim());
      });
  });
}

module.exports = new PrinterService();
