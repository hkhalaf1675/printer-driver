const printerService = require('../../services/printer-pdf-pkd');
const fs = require('fs-extra');

module.exports = {
  async getPrinters(req, res) {
    try {
      const list = await printerService.getPrinters();
      res.json({ ok: true, data: list });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  },

  async getDefaultPrinter(req, res) {
    try {
      const name = await printerService.getDefaultPrinter();
      res.json({ ok: true, data: name });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  },

  async setDefaultPrinter(req, res) {
    try {
      const { name } = req.body;
      if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
      const result = await printerService.setDefaultPrinter(name);
      res.json({ ok: true, data: result });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  },

  // Add a print job to the queue.
  // Accepts multipart file upload (field: file) OR a JSON body with url/data.
  async addJob(req, res) {
    try {
      // multer puts uploaded file into req.file (single) or req.files
      const body = req.body || {};
      const file = req.file; // optional

      // Build jobOptions
      const jobOptions = {};
      // allow client to supply type (system|serial|escpos) - default system
      jobOptions.type = body.type || 'system';
      if (body.printerName) jobOptions.printerName = body.printerName;
      if (body.copies) jobOptions.copies = Number(body.copies) || 1;

      // serial/escpos options may be sent as JSON strings
      if (body.serialOptions) {
        try { jobOptions.serialOptions = JSON.parse(body.serialOptions); } catch (e) { jobOptions.serialOptions = body.serialOptions; }
      }
      if (body.escposOptions) {
        try { jobOptions.escposOptions = JSON.parse(body.escposOptions); } catch (e) { jobOptions.escposOptions = body.escposOptions; }
      }

      // file upload takes precedence
      if (file) {
        // multer already stored the file on disk; pass the path
        jobOptions.filePath = file.path;
      } else if (body.url) {
        jobOptions.url = body.url;
      } else if (body.data) {
        // if client sends base64 content and indicates b64=1
        if (body.b64 === '1' || body.b64 === 1 || body.b64 === 'true') {
          jobOptions.data = Buffer.from(body.data, 'base64');
        } else {
          jobOptions.data = body.data;
        }
      }

      // any extra metadata
      if (body.metadata) {
        try { jobOptions.metadata = JSON.parse(body.metadata); } catch (e) { jobOptions.metadata = body.metadata; }
      }

      const jobId = await printerService.addJobToQueue(jobOptions);
      res.json({ ok: true, jobId });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  },

  async getQueueStatus(req, res) {
    try {
      const status = await printerService.getQueueStatus();
      res.json({ ok: true, data: status });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  },

  async getJob(req, res) {
    try {
      const { id } = req.params;
      const all = await printerService.getQueueStatus();
      const found = (all.jobs || []).find(j => j.id === id);
      if (!found) return res.status(404).json({ ok: false, error: 'job not found' });
      res.json({ ok: true, data: found });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  },

  async getStatus(req, res) {
    res.status(200).json({
      status: 'online',
      message: 'LIMS Print Service is running.',
      timestamp: new Date().toISOString(),
    });
  }
};
