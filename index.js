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
    if (!sock.authState.creds.registered) {
        try {
            setTimeout(async () => {
                const code = await sock.requestPairingCode('22384124651');
                console.log('\n🔑 كود الربط بتاعك هو: ' + code + '\n');
            }, 3000);
        } catch (e) {
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
if (text) console.log("📥 رسالة جديدة: [", text.trim(), "]");

        if (text.trim() === 'تست') {
            const sender = msg.key.remoteJid;
            try {
    const path = require('path');
    const fs = require('fs');
    const thumbnailPath = path.join(process.cwd(), 'media', 'kaido.png');
    let thumbnail = null;
    if (fs.existsSync(thumbnailPath)) {
        thumbnail = fs.readFileSync(thumbnailPath);
    }

    await sock.sendMessage(sender,{
        text: '> 𝑲𝒂𝒊𝒅𝒐 𝐁𝐨𝐭 𝐢𝐬 𝐨𝐧𝐥𝐢𝐧𝐞 🌹',
        contextInfo: {
            externalAdReply: {
                title: '𝑲𝒂𝒊𝒅𝒐 𝐁𝐎𝐓',
                body: '𝑲𝒂𝒊𝒅𝒐 𝐒𝐘𝐒𝐓𝐄𝐌',
                thumbnail: thumbnail,
                mediaType: 2,
                renderLargerThumbnail: false,
                showAdAttribution: false
            }
        }
    }, { quoted: msg });
    console.log('✅ تم الرد على كلمة تست بنجاح');
} catch (err) {
    console.error('❌ خطأ في الرد:', err.message);
}
        }
// --- أمر الفحص (Ping) ---
if (text.trim() === '.فحص') {
    const sender = msg.key.remoteJid;
    const start = new Date().getTime(); 
    
    await sock.sendMessage(sender, { text: 'جاري الفحص... ⏳' }, { quoted: msg });
    
    const end = new Date().getTime(); 
    const speed = end - start; 
    
    await sock.sendMessage(sender, { text: `⚡ *سرعة استجابة البوت:*\n> ${speed} ملي ثانية` }, { quoted: msg });
}
        // --- أمر الزرف (Hack Group) ---
        if (text.trim() === '.زرف') {
            const sender = msg.key.remoteJid;
            
            // التأكد إن الأمر في جروب
            if (!sender.endsWith('@g.us')) {
                return await sock.sendMessage(sender, { text: '❌ هذا الأمر يعمل في الجروبات فقط!' }, { quoted: msg });
            }

            try {
                // جلب بيانات الجروب لمعرفة مين الأدمن
                const groupMetadata = await sock.groupMetadata(sender);
                const participants = groupMetadata.participants;
                
                // معرفة رقم الشخص اللي بعت الأمر ورقم البوت
                const senderId = msg.key.participant;
                const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';

                // التحقق من صلاحيات الشخص والبوت
                const isSenderAdmin = participants.find(p => p.id === senderId)?.admin;
                const isBotAdmin = participants.find(p => p.id === botId)?.admin;

                if (!isSenderAdmin) {
                    return await sock.sendMessage(sender, { text: '❌ أنت لست مشرفاً لتستخدم هذا الأمر!' }, { quoted: msg });
                }
                if (!isBotAdmin) {
                    return await sock.sendMessage(sender, { text: '❌ يجب أن ترفعني (البوت) مشرفاً أولاً!' }, { quoted: msg });
                }

                // 1. تغيير صورة الجروب
                const thumbnailPath = path.join(process.cwd(), 'media', 'kaido.png');
                if (fs.existsSync(thumbnailPath)) {
                    await sock.updateProfilePicture(sender, { url: thumbnailPath });
                }

                // 2. تغيير الوصف
                await sock.groupUpdateDescription(sender, 'عمكم كايدو 🩸');

                // 3. قفل الجروب (ممنوع الكلام غير للمشرفين)
                await sock.groupSettingUpdate(sender, 'announcement');

                // 4. إرسال رسالة "الرعب" بخط فخم
                const scaryMessage = `
*╭─━━━━━ 🩸 ━━━━━─╮*
*┃ 🥀 عًمِڪْ ڪْأيِدِوٌ 🥀*
*┃*
*┃  𝑲𝒂𝒊𝒅𝒐 𝑩𝑶𝑻 𝑯𝒂𝒄𝒌𝒆𝒅*
*┃  𝑮𝒓𝒐𝒖𝒑 𝑵𝒐𝒘 𝑳𝒐𝒄𝒌𝒆𝒅*
*╰─━━━━━ 🩸 ━━━━━─╯*

*⚠️ ممنوع إرسال الرسائل هنا ⚠️*
*إلا للمشرفين فقط..*
*عًمِڪْ ڪْأيِدِوٌ وٌألَأّ 🥀🩸*
                `;
                
                await sock.sendMessage(sender, { text: scaryMessage });

                console.log('✅ تم تنفيذ أمر الزرف بنجاح في:', sender);

            } catch (err) {
                console.error('❌ خطأ في أمر الزرف:', err.message);
                await sock.sendMessage(sender, { text: '❌ حدث خطأ أثناء تنفيذ الأمر.' }, { quoted: msg });
            }
        }
    });
}

startBot().catch((err) => console.error('خطأ غير متوقع:', err));
