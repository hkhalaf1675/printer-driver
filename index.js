const express = require('express');
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const printer = require('pdf-to-printer');
const PrintingOptions = {};

const app = express();
app.use(express.json({ limit: '50mb' }));

const TMP = path.join(os.tmpdir(), 'node-printer-service');
const UPLOAD = multer({ dest: TMP });

const PORT = 3700;
const HOST = '127.0.0.1';

async function ensureTmp() {
  try { await fs.mkdir(TMP, { recursive: true }); } catch (e) {}
}

async function safeUnlink(file) {
  try { await fs.unlink(file); } catch(e) {}
}

app.get('/printers', async (req, res) => {
  try {
    const list = await printer.getPrinters();
    res.json({ ok: true, printers: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, timestamp: Date.now() }));


app.post('/set-default-printer', async(req, res) => {
    const { printerName } = req.body;

    if(!printerName){
        return res.status(404).json({
            ok: false,
            error: 'Printer Name is required'
        });
    }

    PrintingOptions.printer = printerName;

    return res.status(200).json({
        ok: true,
        message: 'printer set as a default successfully'
    });
});

app.post('/print', UPLOAD.single('file'), async (req, res) => {
  await ensureTmp();

  const printerName = (req.body.printerName || req.query.printerName || null);
  let filePath = null;
  let createdTemp = false;

  try {
    // 1) If file uploaded via multipart form-data
    if (req.file) {
        filePath = req.file.path;
        createdTemp = true;
    } else if (req.body.url) {
        // 2) If URL provided, download it
        const url = req.body.url;
        if (!/^https?:\/\//i.test(url)) throw new Error('invalid url');
        const resp = await fetch(url, { method: 'GET', redirect: 'follow' });
        if (!resp.ok) throw new Error(`download failed: ${resp.status} ${resp.statusText}`);
        const arrayBuffer = await resp.arrayBuffer();
        await fs.writeFile(tmpFile, Buffer.from(arrayBuffer), { flag: 'w' });
        filePath = tmpFile;
        createdTemp = true;
    } else if (req.body.base64Pdf) {
        // 3) base64 payload
        const data = req.body.base64Pdf.replace(/^data:application\/pdf;base64,/, '');
        const tmpFile = path.join(TMP, `b64-${Date.now()}.pdf`);
        await fs.writeFile(tmpFile, Buffer.from(data, 'base64'));
        filePath = tmpFile;
        createdTemp = true;
    } else {
        return res.status(400).json({ ok: false, error: 'no file/url/base64Pdf provided' });
    }

    // confirm file exists
    await fs.access(filePath);

    // get list of printers
    const printers = await printer.getPrinters();
    // Optional: if user didn't pick a printer, the library will use default
    const availableNames = printers.map(p => (typeof p === 'string' ? p : p.name || JSON.stringify(p)));

    // If requested a specific printer, verify it exists
    if (printerName) {
      const found = availableNames.find(p => p.toLowerCase() === printerName.toLowerCase());
      if (!found) {
        return res.status(400).json({ ok: false, error: 'printer not found', availablePrinters: availableNames });
      }
    }

    // print
    if (printerName) PrintingOptions.printer = printerName;

    // pdf-to-printer returns a promise
    await printer.print(filePath, PrintingOptions);

    res.json({ ok: true, message: 'print job sent', printerRequested: printerName || 'default', availablePrinters: availableNames });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    if (createdTemp && filePath) await safeUnlink(filePath).catch(()=>{});
  }
});

// small helper to shut down (if running as app)
process.on('SIGINT', ()=> process.exit());
process.on('SIGTERM', ()=> process.exit());

(async () => {
  await ensureTmp();
  app.listen(PORT, HOST, () => {
    console.log(`Printer service listening at http://${HOST}:${PORT}`);
    console.log(`Temp folder: ${TMP}`);
  });
})();
