
const express = require('express');
const multer = require('multer');
const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const controller = require('../../api/controllers/printerController');
const router = express.Router();

const uploadDir = path.join(os.tmpdir(), 'printer-uploads');
fs.ensureDirSync(uploadDir);

// store uploads in system tmp dir to avoid filling project dir
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const name = Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, name);
  }
});
const upload = multer({ storage });

// discovery
router.get('/printers', controller.getPrinters.bind(controller));
router.get('/printers/default', controller.getDefaultPrinter.bind(controller));
router.post('/printers/set-default', express.json(), controller.setDefaultPrinter.bind(controller));

// jobs
// Accepts either multipart/form-data with a file field named `file`, or JSON with url/data
router.post('/jobs', upload.single('file'), controller.addJob.bind(controller));
router.get('/jobs', controller.getQueueStatus.bind(controller));
router.get('/jobs/:id', controller.getJob.bind(controller));

// statsu
router.get('/status', controller.getStatus.bind(controller));

module.exports = router;