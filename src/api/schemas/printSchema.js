const Joi = require('joi');

const printJobSchema = Joi.object({
  printerName: Joi.string().optional().description('Unique Name of the target printer. Uses default if not provided.'),
  
  type: Joi.string().valid('url', 'file').required().description('Type of job to determine default printer.'),
  
  // contentType: Joi.string().valid('ZPL', 'RAW', 'PDF', 'PNG').required().description('The format of the print data.'),
  
  source: Joi.string().required().description('The print data, either raw text (ZPL, RAW) or base64 encoded (PDF, PNG).'),
  
  // copies: Joi.number().integer().min(1).default(1).description('Number of copies to print.'),
});

const setDefaultPrinterSchema = Joi.object({
  name: Joi.string().required().description('Name of the target printer. Uses default if not provided.')
})

module.exports = { printJobSchema, setDefaultPrinterSchema };