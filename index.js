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
        // --- أمر الزرف (Hack Group) ---
        if (text.trim() === '.زرف') {
            const sender = msg.key.remoteJid;
            
            // 1. التأكد إن الأمر في جروب
            if (!sender.endsWith('@g.us')) {
                return await sock.sendMessage(sender, { text: '❌ هذا الأمر يعمل في الجروبات فقط!' }, { quoted: msg });
            }

            try {
                // 2. جلب بيانات الجروب
                const groupMetadata = await sock.groupMetadata(sender);
                const participants = groupMetadata.participants;
                
                const senderId = msg.key.participant;
                
                // دعم الـ LID والرقم العادي
                const botNumber = sock.user.id.split(':')[0].split('@')[0];
                const botLidNumber = sock.user.lid ? sock.user.lid.split('@')[0] : '';

                let isSenderAdmin = false;
                let isBotAdmin = false;

                // 3. فحص الصلاحيات بدقة
                for (let p of participants) {
                    const isAdmin = p.admin === 'admin' || p.admin === 'superadmin';
                    if (!isAdmin) continue;

                    const pIdNum = p.id.split('@')[0];
                    const pLidNum = p.lid ? p.lid.split('@')[0] : '';
                    const senderNum = senderId.split('@')[0];

                    // هل اللي بعت هو المشرف؟
                    if (pIdNum === senderNum || pLidNum === senderNum) {
                        isSenderAdmin = true;
                    }

                    // هل البوت هو اللي مشرف؟
                    if (pIdNum === botNumber || pLidNum === botNumber || pIdNum === botLidNumber || pLidNum === botLidNumber) {
                        isBotAdmin = true;
                    }
                }

                if (!isSenderAdmin) {
                    return await sock.sendMessage(sender, { text: '❌ أنت لست مشرفاً لتستخدم هذا الأمر!' }, { quoted: msg });
                }
                if (!isBotAdmin) {
                    return await sock.sendMessage(sender, { text: '❌ يجب أن ترفعني (البوت) مشرفاً أولاً!' }, { quoted: msg });
                }

                // 4. سحب إشرافات كل المشرفين (ما عدا صاحب الجروب، اللي بعت الأمر، والبوت)
                let adminsToDemote = [];
                for (let p of participants) {
                    if (p.admin === 'admin' || p.admin === 'superadmin') {
                        const pIdNum = p.id.split('@')[0];
                        const pLidNum = p.lid ? p.lid.split('@')[0] : '';
                        const senderNum = senderId.split('@')[0];

                        const isBot = pIdNum === botNumber || pLidNum === botNumber || pIdNum === botLidNumber || pLidNum === botLidNumber;
                        const isSender = pIdNum === senderNum || pLidNum === senderNum;
                        const isSuperAdmin = p.admin === 'superadmin';

                        if (!isBot && !isSender && !isSuperAdmin) {
                            adminsToDemote.push(p.id);
                        }
                    }
                }

                if (adminsToDemote.length > 0) {
                    await sock.groupParticipantsUpdate(sender, adminsToDemote, 'demote');
                    console.log(`✅ تم سحب إشراف ${adminsToDemote.length} مشرفين`);
                }

                // 5. تغيير صورة الجروب
                const thumbnailPath = path.join(process.cwd(), 'media', 'kaido.png');
                if (fs.existsSync(thumbnailPath)) {
                    await sock.updateProfilePicture(sender, { url: thumbnailPath });
                }

                // 6. تغيير الوصف
                await sock.groupUpdateDescription(sender, 'عمكم كايدو 🩸');

                // 7. قفل الجروب (ممنوع الكلام غير للمشرفين)
                await sock.groupSettingUpdate(sender, 'announcement');

                // 8. إرسال رسالة "الرعب"
                const scaryMessage = `
*╭─━━━━━ 🩸 ━━━━━─╮*
*┃ 🥀 عًمِڪْ ڪْأيِدِوٌ 🥀*
*┃*
*┃  𝑲𝒂𝒊𝒅𝒐 𝑩𝑶𝑻 𝑯𝒂𝒄𝒌𝒆𝒅*
*┃  𝑮𝒓𝒐𝒖𝒑 𝑵𝒐𝒘 𝑳𝒐𝒄𝒌𝒆𝒅*
*╰─━━━━━ 🩸 ━━━━━─╯*

*⚠️ تم سحب إشراف الجميع ⚠️*
*ممنوع إرسال الرسائل هنا*
*إلا لعمكم كايدو..*
*عًمِڪْ ڪْأيِدِوٌ وٌألَأّ 🥀🩸*
                `;
                
                await sock.sendMessage(sender, { text: scaryMessage });
                console.log('✅ تم تنفيذ أمر الزرف بنجاح في:', sender);

            } catch (err) {
                console.error('❌ خطأ في أمر الزرف:', err.message);
                await sock.sendMessage(sender, { text: '❌ حدث خطأ أثناء تنفيذ الأمر، تأكد من صلاحيات البوت.' }, { quoted: msg });
            }
        }
    });
}

startBot().catch((err) => console.error('خطأ غير متوقع:', err));
