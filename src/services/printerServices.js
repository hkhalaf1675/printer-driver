const { exec } = require('child_process');
const os = require('os');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const jobQueue = [];
let isPrinting = false;
const tempDir = path.join(__dirname, '..', 'temp');

if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
}

// Helper function to run shell commands
const runCommand = (cmd) => new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message));
        resolve(stdout.trim());
    });
});

async function processQueue() {
    if (isPrinting || jobQueue.length === 0) return;

    isPrinting = true;
    const job = jobQueue.shift();
    logger.info(`[Queue] Processing job ${job.id} for printer: ${job.printer}`);

    let filePathToPrint = job.source;
    try {
        if (job.type === 'url') {
            const fileName = `download_${job.id}${path.extname(new URL(job.source).pathname) || '.pdf'}`;
            filePathToPrint = path.join(tempDir, fileName);
            const response = await axios({ method: 'GET', url: job.source, responseType: 'stream' });
            const writer = fs.createWriteStream(filePathToPrint);
            response.data.pipe(writer);
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve); writer.on('error', reject);
            });
        }

        const platform = os.platform();
        let command;
        if (platform === 'win32') {
            command = `print /d:"${job.printer}" "${filePathToPrint}"`;
        } else { // macOS and Linux
            command = `lp -d "${job.printer}" "${filePathToPrint}"`;
        }

        const result = await runCommand(command);
        logger.info(`[CLI] Print command executed for job ${job.id}. Output: ${result}`);

    } catch (error) {
        logger.error(`[Queue] Failed to process job ${job.id}:`, error.message);
        job.status = 'failed';
    } finally {
        try { fs.unlinkSync(filePathToPrint); } catch (e) {
            logger.error(e);
        }
        isPrinting = false;
        process.nextTick(processQueue);
    }
}

/**
 * 
 * @returns {Array<object>}
 */
async function getPrinters() {
    const platform = os.platform();
    if (platform === 'win32') {
        const output = await runCommand('wmic printer get name,default');
        return output.split('\n').slice(1).map(line => {
            const parts = line.trim().split(/\s{2,}/); // Split on 2 or more spaces
            return { name: parts[1], isDefault: parts[0].toLowerCase() === 'true' };
        }).filter(p => p.name);
    } else { // macOS and Linux
        const [namesOutput, defaultOutput] = await Promise.all([
            runCommand("lpstat -p | awk '{print $2}'"),
            runCommand("lpstat -d | awk '{print $NF}'")
        ]);
        const defaultPrinter = defaultOutput.trim();
        return namesOutput.split('\n').map(name => ({
            name: name.trim(),
            isDefault: name.trim() === defaultPrinter
        })).filter(p => p.name);
    }
}

async function setDefaultPrinter(printerName) {
    const printers = await getPrinters();
    if(printers.some(p => p.name == printerName)){
        const platform = os.platform();
        const command = platform === 'win32'
            ? `RUNDLL32 PRINTUI.DLL,PrintUIEntry /y /n "${printerName}"`
            : `lpoptions -d "${printerName}"`;
        runCommand(command);
        return { success: true }
    }
    else {
        return { success: false, error: 'there is no printer exists with this name'}
    }
}

async function addJobToQueue(jobDetails) {
    const { printerName, type, source, contentType, copies = 1 } = jobDetails;
    let targetPrinter = printerName;
    if (!targetPrinter) {
        const printers = await getPrinters();
        const defaultPrinter = printers.find(p => p.isDefault);
        if (!defaultPrinter) throw new Error('No default printer is set and no printer was specified.');
        targetPrinter = defaultPrinter.name;
    }
    
    const newJobs = Array.from({length: copies}, (_, i) => {
        return {
            id: (Date.now() + i),
            printer: targetPrinter,
            type,
            source,
            status: 'queued'
        }
    });
    jobQueue.push(...newJobs);
    process.nextTick(processQueue);
    return newJobs;
}

function getQueueStatus() {
    return { isPrinting, queueSize: jobQueue.length, jobs: jobQueue };
}

module.exports = { getPrinters, setDefaultPrinter, addJobToQueue, getQueueStatus };