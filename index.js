const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const readline = require('readline');

const AUTH_DIR = 'auth_info_baileys';

// دي عشان يطلب منك الرقم في التيرمنال
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});
const ask = (q) => new Promise(res => rl.question(q, res));

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        printQRInTerminal: false // قفلنا الـ QR خالص
    });

    sock.ev.on('creds.update', saveCreds);

    // لو لسه مش مربوط، اطلب كود ربط
            console.log('في مشكلة في طلب الكود:', e.message);
            console.log('اتأكد ان الرقم صح، وامسح مجلد auth_info_baileys وجرب تاني');
        }
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = statusCode === DisconnectReason.loggedOut;
            console.log('تم إغلاق الاتصال. الكود:', statusCode);

            if (loggedOut) {
                console.log('تم تسجيل الخروج. جاري حذف الجلسة، شغّل البوت من جديد.');
                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                process.exit(0);
            } else {
                setTimeout(startBot, 2000);
            }
        } else if (connection === 'open') {
            console.log('\n✅ تم الاتصال بنجاح! البوت جاهز.');
            rl.close();
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

startBot().catch((err) => console.error('خطأ غير متوقع:', err));
