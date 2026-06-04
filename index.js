require('dotenv').config();

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
} = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode'); // npm install qrcode
const P = require('pino');

const app = express();
// const logger = P({ level: 'silent' });
const logger = P({ level: 'warn' });

app.use(cors());
app.use(express.json());

let sock;
let isConnected = false;
let lastQR = null; // simpan QR string terakhir

// ── Helper: format nomor ke JID ───────────────────────────────────
function toJid(phone) {
    const normalized = phone.replace(/[\s\-()]/g, '').replace(/^0/, '62');
    return `${normalized}@s.whatsapp.net`;
}

// ── Template pesan notifikasi pendaftar baru ──────────────────────
function buildRegistrationMessage(data) {
    const waktu = new Date().toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
        dateStyle: 'full',
        timeStyle: 'short',
    });

    return [
        `🔔 *PENDAFTAR BARU*`,
        ``,
        `📋 *Data Pendaftar:*`,
        `👤 Nama     : ${data.name}`,
        `📱 WhatsApp : ${data.phone}`,
        `🏫 Jurusan  : ${data.program}`,
        data.message ? `💬 Pesan    : ${data.message}` : null,
        ``,
        `🕐 Waktu    : ${waktu}`,
        ``,
        `_Silakan segera hubungi calon siswa dan perbarui status di panel admin._`,
        ``,
        // `🔗 Admin Panel: ${process.env.ADMIN_URL ?? 'http://localhost:8000/admin/registrations'}`,
    ]
        .filter((line) => line !== null)
        .join('\n');
}

// ── WhatsApp connection ───────────────────────────────────────────
async function startWA() {
    const { state, saveCreds } = await useMultiFileAuthState('auth');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger,
        connectTimeoutMs: 60_000,
        keepAliveIntervalMs: 10_000,
        retryRequestDelayMs: 250,
        syncFullHistory: false, // ← tambahkan ini
        shouldSyncHistoryMessage: () => false, // ← dan ini
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            lastQR = qr;
            console.log('\n📱 QR siap! Buka browser: http://localhost:3001/qr');
        }

        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !==
                DisconnectReason.loggedOut;
            console.log('Koneksi terputus. Reconnect:', shouldReconnect);
            if (shouldReconnect) startWA();
        }

        if (connection === 'open') {
            isConnected = true;
            lastQR = null; // QR sudah tidak dibutuhkan
            console.log('✅ WhatsApp terhubung');
        }
    });
}

startWA();

// ── Middleware: cek koneksi WA ────────────────────────────────────
function requireConnected(req, res, next) {
    if (!isConnected) {
        return res.status(503).json({
            error: 'WhatsApp belum terhubung. Buka http://localhost:3001/qr untuk scan QR.',
        });
    }
    next();
}

// ── GET /qr  — buka di browser, scan QR dari sini ────────────────
app.get('/qr', async (req, res) => {
    if (isConnected) {
        return res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0fdf4">
                <h2 style="color:#16a34a">✅ WhatsApp Sudah Terhubung!</h2>
                <p>Gateway aktif dan siap menerima request.</p>
            </body></html>
        `);
    }

    if (!lastQR) {
        return res.send(`
            <html>
            <head>
                <meta http-equiv="refresh" content="3">
            </head>
            <body style="font-family:sans-serif;text-align:center;padding:60px;background:#fefce8">
                <h2>⏳ Menunggu QR...</h2>
                <p>Halaman akan refresh otomatis setiap 3 detik.</p>
                <p style="color:#92400e">Pastikan <code>node index.js</code> sudah berjalan.</p>
            </body></html>
        `);
    }

    try {
        // Render QR sebagai gambar PNG base64
        const qrImage = await qrcode.toDataURL(lastQR, {
            width: 350,
            margin: 2,
        });

        res.send(`
            <html>
            <head>
                <meta http-equiv="refresh" content="30">
                <title>Scan WA QR</title>
            </head>
            <body style="font-family:sans-serif;text-align:center;padding:40px;background:#fff">
                <h2>📱 Scan QR Code dengan WhatsApp</h2>
                <p style="color:#6b7280">Buka WhatsApp → Perangkat Tertaut → Tautkan Perangkat</p>
                <img src="${qrImage}" style="border:4px solid #e5e7eb;border-radius:12px;margin:16px 0" />
                <p style="color:#9ca3af;font-size:13px">QR expired dalam ~60 detik. Halaman refresh otomatis.</p>
            </body></html>
        `);
    } catch (err) {
        res.status(500).send('Gagal generate QR: ' + err.message);
    }
});

// ── GET /status ───────────────────────────────────────────────────
app.get('/status', (req, res) => {
    res.json({
        connected: isConnected,
        qr_ready: !isConnected && !!lastQR,
        qr_url: !isConnected ? 'http://localhost:3001/qr' : null,
    });
});

// ── POST /send-message ────────────────────────────────────────────
app.post('/send-message', requireConnected, async (req, res) => {
    const { phone, message } = req.body;

    if (!phone || !message) {
        return res.status(400).json({ error: 'phone & message required' });
    }

    try {
        await sock.sendMessage(toJid(phone), { text: message });
        res.json({ success: true });
    } catch (err) {
        console.error('[send-message] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ── POST /notify-registration ─────────────────────────────────────
app.post('/notify-registration', requireConnected, async (req, res) => {
    const { name, phone, program, message } = req.body;

    if (!name || !phone || !program) {
        return res
            .status(400)
            .json({ error: 'name, phone & program required' });
    }

    const recipients = process.env.SCHOOL_NOTIFY_PHONES
        ? process.env.SCHOOL_NOTIFY_PHONES.split(',').map((p) => p.trim())
        : [];

    if (recipients.length === 0) {
        console.warn(
            '[notify-registration] SCHOOL_NOTIFY_PHONES tidak dikonfigurasi.',
        );
        return res
            .status(500)
            .json({ error: 'Nomor tujuan notifikasi belum dikonfigurasi.' });
    }

    const text = buildRegistrationMessage({ name, phone, program, message });

    try {
        await Promise.all(
            recipients.map((recipient) =>
                sock.sendMessage(toJid(recipient), { text }),
            ),
        );

        console.log(
            `[notify-registration] Notifikasi terkirim ke ${recipients.length} nomor untuk: ${name}`,
        );
        res.json({ success: true, notified: recipients.length });
    } catch (err) {
        console.error('[notify-registration] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(3001, () => {
    console.log('🚀 WA Gateway berjalan di port 3001');
    console.log('📱 Untuk scan QR, buka: http://localhost:3001/qr');
});
