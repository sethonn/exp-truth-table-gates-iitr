require('dotenv').config();
const express = require('express');
const path = require('path');
const Razorpay = require('razorpay');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const cors = require('cors');
const pino = require('pino');

// Configure pino logger (pretty transport disabled)
const logger = pino();

// Optional remote log shipping
const LOG_SHIP_PROVIDER = (process.env.LOG_SHIP_PROVIDER || '').toLowerCase();
const LOG_SHIP_URL = process.env.LOG_SHIP_URL || '';
const LOG_SHIP_API_KEY = process.env.LOG_SHIP_API_KEY || '';
const os = require('os');

// Batched log shipping
const LOG_BATCH_SIZE = parseInt(process.env.LOG_BATCH_SIZE || '25', 10); // send when this many entries
const LOG_FLUSH_INTERVAL = parseInt(process.env.LOG_FLUSH_INTERVAL_MS || '2000', 10); // ms
const LOG_MAX_RETRIES = parseInt(process.env.LOG_MAX_RETRIES || '3', 10);

const logBuffer = [];
let flushTimer = null;
let lastFlushTime = null;
let totalBatchesShipped = 0;
let totalBatchesFailed = 0;

function scheduleFlush(ms = LOG_FLUSH_INTERVAL) {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flushLogs(); }, ms);
}

function enqueueLog(payload) {
    if (!LOG_SHIP_URL && !LOG_SHIP_PROVIDER) return;
    logBuffer.push({ payload, attempts: 0 });
    if (logBuffer.length >= LOG_BATCH_SIZE) {
        // flush immediately
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        void flushLogs();
    } else {
        scheduleFlush();
    }
}

async function flushLogs() {
    if (!logBuffer.length) return;
    // take a batch
    const batch = logBuffer.splice(0, LOG_BATCH_SIZE);
    const entries = batch.map(item => item.payload);

    try {
        if (LOG_SHIP_PROVIDER === 'logdna') {
            const hostname = encodeURIComponent(os.hostname() || 'server');
            const url = LOG_SHIP_URL || `https://logs.logdna.com/logs/ingest?hostname=${hostname}`;
            const lines = entries.map(e => ({
                line: e.msg || JSON.stringify(e),
                app: 'razorpay-server',
                level: e.level || 'info',
                meta: e.meta || {}
            }));
            const headers = { 'Content-Type': 'application/json' };
            if (LOG_SHIP_API_KEY) {
                const token = Buffer.from(`${LOG_SHIP_API_KEY}:`).toString('base64');
                headers['Authorization'] = `Basic ${token}`;
            }
            const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ lines }) });
            if (!resp.ok) throw new Error(`status ${resp.status}`);
            lastFlushTime = Date.now();
            totalBatchesShipped++;
            return;
        }

        // Generic shipper posts array of entries
        const url = LOG_SHIP_URL;
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(LOG_SHIP_API_KEY ? { 'Authorization': `Bearer ${LOG_SHIP_API_KEY}` } : {})
            },
            body: JSON.stringify(entries)
        });
        if (!resp.ok) throw new Error(`status ${resp.status}`);
        lastFlushTime = Date.now();
        totalBatchesShipped++;
        return;
    } catch (err) {
        logger.warn({ err }, 'batch ship failed, scheduling retry');
        totalBatchesFailed++;
        // retry logic: requeue with incremented attempts
        batch.forEach(item => {
            item.attempts = (item.attempts || 0) + 1;
            if (item.attempts <= LOG_MAX_RETRIES) {
                logBuffer.unshift(item); // retry sooner
            } else {
                logger.warn({ item }, 'dropping log after max retries');
            }
        });
        // schedule next flush with backoff
        scheduleFlush(1000 * Math.min(8, Math.pow(2, Math.min(5, batch[0].attempts || 1))));
    }
}

// Wrap logger methods to also ship logs remotely when configured
if (LOG_SHIP_URL) {
    const wrap = (level) => {
        const orig = logger[level].bind(logger);
        logger[level] = (...args) => {
            try {
                // call original pino logger
                orig(...args);
                // Build a simple payload: level + timestamp + first arg/message
                const payload = {
                    level,
                    time: new Date().toISOString(),
                    pid: process.pid
                };
                if (args.length === 1 && typeof args[0] === 'object') {
                    payload.msg = args[0].msg || args[0].message || '';
                    payload.meta = args[0];
                } else {
                    payload.msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
                }
                // fire-and-forget
                // enqueue payload for batched shipping
                enqueueLog(payload);
            } catch (e) {
                orig(...args);
            }
        };
    };
    ['info', 'warn', 'error', 'fatal', 'debug', 'trace'].forEach(wrap);
    logger.info('Remote log shipping enabled', { LOG_SHIP_URL: LOG_SHIP_URL.replace(/(https?:\/\/[^\/]+).*/, '$1') });
}

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Serve demo static files from ./public
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const METRICS_TOKEN = process.env.METRICS_TOKEN || '';

if (!KEY_ID || !KEY_SECRET) {
    logger.warn('Warning: RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET not set in environment. See .env.example');
}

const razorpay = new Razorpay({
    key_id: KEY_ID,
    key_secret: KEY_SECRET
});

app.get('/', (req, res) => {
    res.json({
        message: 'Razorpay server example - endpoints: POST /create-order and POST /verify',
        admin_hint: 'Create a .env from .env.example and set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET, then restart the server.'
    });
});

// Configuration endpoint for clients to check if server has Razorpay keys
app.get('/config', (req, res) => {
    const hasKeys = !!(KEY_ID && KEY_SECRET);
    res.json({
        razorpay: { key_id_present: !!KEY_ID, key_secret_present: !!KEY_SECRET, hasKeys },
        metrics: { token_present: !!METRICS_TOKEN }
    });
});

// Metrics endpoint for log shipping / buffer
function requireMetricsAuth(req, res, next) {
    if (!METRICS_TOKEN) {
        logger.warn('METRICS_TOKEN not set. /metrics endpoint is unsecured');
        return next();
    }
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const token = auth.slice(7).trim();
    if (token !== METRICS_TOKEN) return res.status(403).json({ error: 'Forbidden' });
    return next();
}

app.get('/metrics', requireMetricsAuth, (req, res) => {
    res.json({
        logShipping: {
            provider: LOG_SHIP_PROVIDER || null,
            urlConfigured: !!LOG_SHIP_URL,
            bufferSize: logBuffer.length,
            batchSize: LOG_BATCH_SIZE,
            flushIntervalMs: LOG_FLUSH_INTERVAL,
            maxRetries: LOG_MAX_RETRIES,
            lastFlushAt: lastFlushTime ? new Date(lastFlushTime).toISOString() : null,
            totalBatchesShipped,
            totalBatchesFailed
        }
    });
});

// Create an order on Razorpay (server-side)
// Expects JSON body: { amount: 50 }  // amount in INR
app.post('/create-order', async (req, res) => {
    try {
        const { amount } = req.body;
        logger.info({ amount, ip: req.ip }, 'create-order request received');
        if (!amount || isNaN(amount) || amount <= 0) {
            return res.status(400).json({ error: 'Invalid amount' });
        }

        const amountPaise = Math.round(parseFloat(amount) * 100);
        const options = {
            amount: amountPaise,
            currency: 'INR',
            receipt: `receipt_${Date.now()}`,
            payment_capture: 1
        };

        const order = await razorpay.orders.create(options);
        // Log created order id (do not log secrets)
        logger.info({ order_id: order.id, amount: order.amount, currency: order.currency }, 'order created');
        // Return order and public key_id so client can open Checkout
        return res.json({ order, key_id: KEY_ID });
    } catch (err) {
        logger.error({ err }, 'create-order error');
        return res.status(500).json({ error: 'Unable to create order' });
    }
});

// Verify payment signature (server-side)
// Expects JSON body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
app.post('/verify', (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    logger.info({ order_id: razorpay_order_id, payment_id: razorpay_payment_id, ip: req.ip }, 'verify attempt');
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        logger.warn({ body: req.body }, 'verify failed: missing parameters');
        return res.status(400).json({ error: 'Missing parameters' });
    }

    const generatedSignature = crypto
        .createHmac('sha256', KEY_SECRET)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex');

    if (generatedSignature === razorpay_signature) {
        logger.info({ order_id: razorpay_order_id, payment_id: razorpay_payment_id }, 'verify success');
        // Payment is valid: you can store this in DB and mark order paid
        return res.json({ ok: true, message: 'Signature is valid' });
    }
    logger.warn({ order_id: razorpay_order_id }, 'verify failed: signature mismatch');
    return res.status(400).json({ ok: false, message: 'Invalid signature' });
});

app.listen(PORT, () => {
    logger.info(`Razorpay example server listening on port ${PORT}`);
    if (KEY_ID && KEY_SECRET) {
        logger.info('Razorpay keys: key_id and key_secret are present. Server ready for live orders.');
    } else if (KEY_ID && !KEY_SECRET) {
        logger.warn('Razorpay keys: key_id present, key_secret MISSING. Set RAZORPAY_KEY_SECRET in .env.');
    } else if (!KEY_ID && KEY_SECRET) {
        logger.warn('Razorpay keys: key_secret present, key_id MISSING. Set RAZORPAY_KEY_ID in .env.');
    } else {
        logger.warn('Razorpay keys: MISSING. Create .env from .env.example and set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
    }
});
