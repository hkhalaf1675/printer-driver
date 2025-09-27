const util = require('util');
const printer = require('node-printer');
const logger = require('../utils/logger');
const jobService = require('./jobService');
const config = require('../config');

// Promisify the printer methods for async/await usage
const printDirectAsync = util.promisify(printer.printDirect);

/**
 * Heuristically determines the printer type based on its name.
 * @param {string} printerName - The name of the printer.
 * @returns {string} 'label', 'report', or 'other'.
 */
const getPrinterType = (printerName = '') => {
  const name = printerName.toLowerCase();
  if (name.includes('zebra') || name.includes('dymo') || name.includes('brother ql')) {
    return 'label';
  }
  if (name.includes('laserjet') || name.includes('officejet') || name.includes('deskjet')) {
    return 'report';
  }
  return 'other';
};

/**
 * Lists all available printers with formatted details.
 * @returns {Array} A list of printer objects.
 */
const listPrinters = () => {
  try {
    const printers = printer.getPrinters();
    return printers.map((p) => ({
      id: p.name.replace(/\s+/g, '_'), // Create a URL-friendly ID
      name: p.name,
      type: getPrinterType(p.name),
      status: p.status, // Note: Status can be complex, this gives a raw value
      isDefault: p.isDefault,
    }));
  } catch (error) {
    logger.error('Failed to get printers:', error);
    throw new Error('Could not retrieve installed printers.');
  }
};

/**
 * Submits a print job to a specified printer.
 * @param {object} jobData - The job details from the request body.
 * @returns {object} The status of the print job.
 */
const submitPrintJob = async (jobData) => {
  const { printerId, jobType, contentType, data, copies = 1 } = jobData;

  // Determine the target printer
  const targetPrinterId = printerId || config.printer.defaults[jobType];
  if (!targetPrinterId) {
    jobService.addJob({ ...jobData, status: 'failed', error: 'No target printer specified and no default found.' });
    throw new Error(`No target printer specified for job type '${jobType}' and no default is configured.`);
  }

  const availablePrinters = printer.getPrinters();
  const selectedPrinter = availablePrinters.find(p => p.name.replace(/\s+/g, '_') === targetPrinterId);

  if (!selectedPrinter) {
    jobService.addJob({ ...jobData, status: 'failed', error: 'Printer not found.' });
    throw new Error(`Printer with ID '${targetPrinterId}' not found.`);
  }

  const options = {
    printer: selectedPrinter.name,
    type: 'RAW', // Default type for printDirect
    options: {
      copies: copies,
    },
  };

  let printData;

  // Prepare data based on content type
  if (contentType === 'PDF' || contentType === 'PNG') {
    // Data is base64 encoded, decode it to a buffer
    printData = Buffer.from(data, 'base64');
  } else if (contentType === 'ZPL' || contentType === 'RAW') {
    printData = data;
  } else {
    jobService.addJob({ ...jobData, status: 'failed', error: 'Unsupported content type.' });
    throw new Error(`Content type '${contentType}' is not supported.`);
  }
  
  // Note: For HTML, an external library like Puppeteer would be needed to convert HTML to PDF first.
  // This would significantly increase the service's footprint.
  // It's recommended that the LIMS handles the HTML -> PDF conversion.

  try {
    logger.info(`Sending job to printer: ${selectedPrinter.name} (${copies} copies)`);
    await printDirectAsync({
      data: printData,
      ...options,
    });
    
    const successResult = {
      status: 'success',
      printer: selectedPrinter.name,
      timestamp: new Date().toISOString(),
    };
    
    jobService.addJob({ ...jobData, ...successResult });
    return successResult;

  } catch (error) {
    logger.error(`Print job failed for ${selectedPrinter.name}:`, error);
    jobService.addJob({ ...jobData, status: 'failed', error: error.message });
    throw new Error(`Print job failed: ${error.message}`);
  }
};


module.exports = {
  listPrinters,
  submitPrintJob,
};