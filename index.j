const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs');

const AUTH_DIR = 'auth_info_baileys';

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome')
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        // عرض الـ QR في التيرمنال (بيتجدد تلقائي كل فترة)
        if (qr) {
            console.log('\nافتح واتساب > الأجهزة المرتبطة > ربط جهاز، وامسح الكود:\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = statusCode === DisconnectReason.loggedOut;
            console.log('تم إغلاق الاتصال. الكود:', statusCode);

            if (loggedOut) {
                console.log('تم تسجيل الخروج. جاري حذف الجلسة، شغّل البوت من جديد.');
                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                process.exit(0);
            } else {
                // يشمل كود 515 (إعادة تشغيل طبيعية بعد نجاح الربط)
                setTimeout(startBot, 2000);
            }
        } else if (connection === 'open') {
            console.log('\n✅ تم الاتصال بنجاح! البوت جاهز.');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        const msg = messages[0];
        if (!msg?.message || msg.key.fromMe) return;
        if (msg.key.remoteJid === 'status@broadcast') return;

        const content = msg.message.ephemeralMessage?.message || msg.message;
        const text =
            content.conversation ||
            content.extendedTextMessage?.text ||
            content.imageMessage?.caption ||
            content.videoMessage?.caption ||
            '';

        if (text.trim() === '.تست') {
            const jid = msg.key.remoteJid;
            try {
                await sock.sendMessage(jid, { text: 'تويست' }, { quoted: msg });
                console.log(`تم الرد على أمر .تست في المحادثة: ${jid}`);
            } catch (err) {
                console.error('فشل إرسال الرد:', err.message);
            }
        }
    });
}

startBot().catch((err) => console.error('خطأ غير متوقع:', err))
