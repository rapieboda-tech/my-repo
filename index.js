'use strict';

const {
    default: makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    normalizeMessageContent,
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { performance } = require('perf_hooks');

// ═══════════════ الإعدادات ═══════════════
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const THUMB_PATH = path.join(__dirname, 'media', 'kaido.png');
const DEFAULT_PHONE = '22384124651'; // الرقم الافتراضي للربط

const ALLOWED_CHATS = [];

const logger = pino({ level: 'silent' });

// ═══════════════ الصورة (lazy + cache) ═══════════════
let thumbnail = undefined; // undefined = لسه ماتقرأتش، null = مش موجودة
function getThumbnail() {
    if (thumbnail !== undefined) return thumbnail;
    try {
        if (fs.existsSync(THUMB_PATH)) {
            const buf = fs.readFileSync(THUMB_PATH);
            thumbnail = buf.length > 0 ? buf : null;
        } else {
            thumbnail = null;
        }
    } catch (e) {
        console.log('⚠️ مش قادر أقرأ الصورة:', e.message);
        thumbnail = null;
    }
    return thumbnail;
}

// ═══════════════ حالة عامة ═══════════════
let currentSock = null;
let pairingPhone = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let shuttingDown = false;
let starting = false;
let waVersion = null;

// وضع التسريع: بيفعّل cache للـ metadata + مسار سريع للرسائل
global.botTurbo = false;

const isLinked = (creds) => Boolean(creds?.registered || creds?.account);

// ═══════════════ cache لميتاداتا الجروبات (بيتفعّل مع Turbo) ═══════════════
const groupMetaCache = new Map();
const GROUP_META_TTL = 60 * 1000; // دقيقة

async function getGroupMetadata(sock, jid) {
    if (!global.botTurbo) {
        return sock.groupMetadata(jid);
    }
    const cached = groupMetaCache.get(jid);
    if (cached && Date.now() - cached.ts < GROUP_META_TTL) {
        return cached.data;
    }
    const data = await sock.groupMetadata(jid);
    groupMetaCache.set(jid, { data, ts: Date.now() });
    return data;
}

// ═══════════════ رسائل البوت المرسلة ═══════════════
const sentStore = new Map();
const MAX_STORED = 500;

async function send(sock, jid, content, options) {
    const sent = await sock.sendMessage(jid, content, options);
    if (sent?.key?.id && sent.message) {
        sentStore.set(sent.key.id, sent.message);
        if (sentStore.size > MAX_STORED) {
            sentStore.delete(sentStore.keys().next().value);
        }
    }
    return sent;
}

// ═══════════════ رقم الواتساب ═══════════════
function normalizePhone(raw) {
    const phone = String(raw || '').replace(/\D/g, '');
    return /^[1-9]\d{7,14}$/.test(phone) ? phone : null;
}

function ask(question) {
    return new Promise((resolve) => {
        if (!process.stdin.isTTY) return resolve(null);

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        let answered = false;
        rl.once('close', () => { if (!answered) resolve(null); });
        rl.question(question, (answer) => {
            answered = true;
            rl.close();
            resolve(String(answer || '').trim());
        });
    });
}

async function getPhoneNumber() {
    const preset = normalizePhone(process.env.PHONE_NUMBER || process.argv[2] || DEFAULT_PHONE);
    if (preset) return preset;

    if (!process.stdin.isTTY) {
        console.log('❌ مفيش رقم متاح. حدد الرقم عبر PHONE_NUMBER env أو argv[2] في بيئة السيرفر.');
        return null;
    }

    for (let i = 0; i < 3; i++) {
        const answer = await ask('📱 أدخل رقم الواتساب بكود الدولة (بدون + أو مسافات أو صفر في الأول): ');
        if (answer === null) return null;
        const phone = normalizePhone(answer);
        if (phone) return phone;
        console.log('❌ رقم غير صالح. مثال: 201012345678');
    }
    return null;
}

// ═══════════════ استخراج النص ═══════════════
function extractText(msg) {
    const content = normalizeMessageContent(msg?.message);
    if (!content) return '';
    return String(
        content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.videoMessage?.caption ||
        content.documentMessage?.caption ||
        ''
    )
        .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
        .trim();
}

// ═══════════════ الأوامر ═══════════════
const commands = new Map([
    ['تست', async (sock, jid, msg) => {
        const content = { text: '> 𝑲𝒂𝒊𝒅𝒐 𝐁𝐨𝐭 𝐢𝐬 𝐨𝐧𝐥𝐢𝐧𝐞 🌹' };
        const thumb = getThumbnail();

        if (thumb) {
            try {
                await send(sock, jid, {
                    ...content,
                    contextInfo: {
                        externalAdReply: {
                            title: '𝑲𝒂𝒊𝒅𝒐 𝐁𝐎𝐓',
                            body: '𝑲𝒂𝒊𝒅𝒐 𝐒𝐘𝐒𝐓𝐄𝐌',
                            thumbnail: thumb,
                            mediaType: 2,
                            renderLargerThumbnail: false
                        }
                    }
                }, { quoted: msg });
                console.log('✅ تم الرد على كلمة تست');
                return;
            } catch (err) {
                console.log('⚠️ فشل الإرسال بالصورة، هبعت نص بس:', err.message);
            }
        }

        await send(sock, jid, content, { quoted: msg });
        console.log('✅ تم الرد على كلمة تست');
    }],

    ['.تسريع الاستجابه', async (sock, jid, msg) => {
        global.botTurbo = true;
        groupMetaCache.clear();
        if (global.gc) { try { global.gc(); } catch {} }
        await send(sock, jid, {
            text: `🚀 *تم تفعيل وضع الصاروخ بنجاح!*\n\n> ⚡ تم تفعيل cache لميتاداتا الجروبات (TTL: 60s).\n> 🔥 الأوامر اللي بتعتمد على groupMetadata بقت أسرع فعلياً.\n> 📊 استخدم \`.فحص\` لقياس زمن الاستجابة الحقيقي.`
        }, { quoted: msg });
        console.log('🚀 تم تفعيل وضع التسريع (cache + fast path)');
    }],

    ['.فحص', async (sock, jid, msg) => {
        const start = performance.now();
        let ok = true;
        let errMsg = '';
        try {
            await sock.fetchStatus(jid);
        } catch (err) {
            ok = false;
            errMsg = err.message || String(err);
        }
        const latency = (performance.now() - start).toFixed(2);

        if (!ok) {
            return await send(sock, jid, {
                text: `⚠️ *فحص الاستجابة:*\n> فشل القياس: ${errMsg}`
            }, { quoted: msg });
        }

        const turboLine = global.botTurbo
            ? `\n> 🚀 وضع الصاروخ مفعّل (cache: ${GROUP_META_TTL / 1000}s)`
            : '';

        await send(sock, jid, {
            text: `⚡ *زمن استجابة السيرفر الحقيقي:*\n> ${latency} ms${turboLine}`
        }, { quoted: msg });
    }],

    ['.زرف', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) {
            return await send(sock, jid, { text: '❌ هذا الأمر يعمل في الجروبات فقط!' }, { quoted: msg });
        }

        const senderId = msg.key.participant;
        if (!senderId) {
            return await send(sock, jid, { text: '❌ مش قادر أحدد هوية المرسل.' }, { quoted: msg });
        }

        try {
            const groupMetadata = await getGroupMetadata(sock, jid);
            const participants = groupMetadata.participants || [];

            const botNumber = sock.user?.id?.split(':')[0].split('@')[0] || '';
            const botLidNumber = sock.user?.lid ? sock.user.lid.split('@')[0] : '';
            const senderNum = senderId.split('@')[0];

            let isSenderAdmin = false;
            let isBotAdmin = false;
            const adminsToDemote = [];

            for (const p of participants) {
                const isAdmin = p.admin === 'admin' || p.admin === 'superadmin';
                if (!isAdmin) continue;

                const pIdNum = p.id.split('@')[0];
                const pLidNum = p.lid ? p.lid.split('@')[0] : '';

                if (pIdNum === senderNum || pLidNum === senderNum) isSenderAdmin = true;
                if (
                    pIdNum === botNumber || pLidNum === botNumber ||
                    pIdNum === botLidNumber || pLidNum === botLidNumber
                ) isBotAdmin = true;

                if (p.admin === 'admin') {
                    const isBot = pIdNum === botNumber || pLidNum === botNumber ||
                                  pIdNum === botLidNumber || pLidNum === botLidNumber;
                    const isSender = pIdNum === senderNum || pLidNum === senderNum;
                    if (!isBot && !isSender) adminsToDemote.push(p.id);
                }
            }

            // لازم المرسل أدمن (ده تحقق منطقي في الكود، مش من واتساب)
            if (!isSenderAdmin) {
                return await send(sock, jid, { text: '❌ أنت لست مشرفاً لتستخدم هذا الأمر!' }, { quoted: msg });
            }

            // 🔓 تجاوز تحقق "البوت أدمن" — بنحاول ننفذ العمليات على أي حال
            if (!isBotAdmin) {
                console.log('⚠️ البوت مش أدمن — هيتم محاولة التنفيذ على أي حال.');
            }

            let anyOpFailed = false;

            if (adminsToDemote.length > 0) {
                try {
                    await sock.groupParticipantsUpdate(jid, adminsToDemote, 'demote');
                } catch (err) {
                    anyOpFailed = true;
                    console.log('⚠️ فشل سحب إشراف بعض الأعضاء (ممكن superadmin أو البوت مش أدمن):', err.message);
                }
            }

            const thumb = getThumbnail();
            if (thumb) {
                try {
                    await sock.updateProfilePicture(jid, { url: THUMB_PATH });
                } catch (err) {
                    anyOpFailed = true;
                    console.log('⚠️ فشل تحديث صورة الجروب:', err.message);
                }
            }

            try {
                await sock.groupUpdateDescription(jid, 'عمكم كايدو 🩸');
            } catch (err) {
                anyOpFailed = true;
                console.log('⚠️ فشل تحديث وصف الجروب:', err.message);
            }

            try {
                await sock.groupSettingUpdate(jid, 'announcement');
            } catch (err) {
                anyOpFailed = true;
                console.log('⚠️ فشل قفل الجروب:', err.message);
            }

            // بعد أي تعديل على الجروب، لازم نبطل الـ cache القديم
            groupMetaCache.delete(jid);

            // لو البوت مش أدمن، نوضح للمستخدم إن العمليات الفعلية محتاجة رفع البوت أدمن
            if (!isBotAdmin && anyOpFailed) {
                await send(sock, jid, {
                    text: '⚠️ *تنبيه:* البوت مش أدمن في الجروب، فعمليات سحب الإشراف/قفل الجروب/تغيير الوصف **محتاجة** إن حد يرفع البوت أدمن.\n> الرسالة اللي جاية دي للعرض بس — العمليات الفعلية لم تتنفذ.'
                }, { quoted: msg });
            }

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
            await send(sock, jid, { text: scaryMessage });
            console.log('✅ تم تنفيذ أمر الزرف بنجاح');

        } catch (err) {
            console.error('❌ خطأ في أمر الزرف:', err.message);
            await send(sock, jid, { text: '❌ حدث خطأ أثناء تنفيذ الأمر.' }, { quoted: msg });
        }
    }]
]);

async function handleMessage(sock, msg) {
    const jid = msg?.key?.remoteJid;
    if (!msg?.message || !jid || jid === 'status@broadcast') return;
    if (sentStore.has(msg.key.id)) return;

   // --- حماية المالك (رقمك) ---
const senderJid = msg.key.participant || msg.key.remoteJid;
const senderNum = senderJid.split('@')[0].split(':')[0]; 
console.log(`🔍 الرسالة جاية من: ${senderNum}`); // عشان نتأكد مين اللي بعت
if (senderNum !== '201144953155') return; 
// -------------------------

    // مسار سريع في وضع Turbo: نتخطى تحليل النص لو الرسالة مش نص
    if (global.botTurbo) {
        const content = normalizeMessageContent(msg.message);
        if (!content) return;
    }

    const text = extractText(msg);
    const command = commands.get(text);
    if (!command) return;

    console.log(`📥 أمر: [${text}] من ${jid}`);
    if (ALLOWED_CHATS.length && !ALLOWED_CHATS.includes(jid)) return;

    await command(sock, jid, msg);
}

// ═══════════════ التشغيل وإعادة الاتصال ═══════════════
function scheduleRestart(delay) {
    if (shuttingDown) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(safeStart, delay);
}

async function safeStart() {
    if (shuttingDown || starting) return;
    starting = true;
    try {
        await startBot();
    } catch (err) {
        console.error('❌ فشل تشغيل البوت:', err.message);
        reconnectAttempts++;
        scheduleRestart(Math.min(2000 * reconnectAttempts, 30000));
    } finally {
        starting = false;
    }
}

async function startBot() {
    let { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    // لو الجلسة مش مربوطة فعلاً، نمسحها ونبدأ من جديد
    if (!isLinked(state.creds)) {
        console.log('🧹 لقيت جلسة غير مكتملة، هبدأ من جديد.');
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
        ({ state, saveCreds } = await useMultiFileAuthState(AUTH_DIR));
    }

    if (!isLinked(state.creds) && !pairingPhone) {
        pairingPhone = await getPhoneNumber();
        if (!pairingPhone) {
            console.log('❌ مفيش رقم (الإدخال اتقفل أو اتلغى).');
            process.exit(1);
        }
    }

    if (!waVersion) {
        try {
            const { version, isLatest } = await fetchLatestBaileysVersion();
            if (isLatest) waVersion = version;
        } catch {}
    }

    const sock = makeWASocket({
        ...(waVersion ? { version: waVersion } : {}),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        logger,
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: false,
        getMessage: async (key) => sentStore.get(key.id)
    });

    currentSock = sock;
    let codeRequested = false;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && pairingPhone && !codeRequested && !isLinked(state.creds)) {
            codeRequested = true;
            try {
                const code = await sock.requestPairingCode(pairingPhone);
                const pretty = (code.match(/.{1,4}/g) || [code]).join('-');
                console.log('\n🔑 كود الربط بتاعك هو: ' + pretty + '\n');
                console.log('👈 واتساب > الأجهزة المرتبطة > ربط جهاز > الربط برقم الهاتف بدلاً من ذلك');
            } catch (err) {
                console.log('❌ مشكلة في طلب الكود:', err.message);
                codeRequested = false;
            }
        }

        if (connection === 'open') {
            reconnectAttempts = 0;
            pairingPhone = null;
            console.log('\n✅ تم الاتصال بنجاح! البوت جاهز.');
            return;
        }

        if (connection !== 'close') return;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log('🔌 تم إغلاق الاتصال. الكود:', statusCode);

        setImmediate(() => {
            try { sock.ev.removeAllListeners('connection.update'); } catch {}
            try { sock.ev.removeAllListeners('messages.upsert'); } catch {}
        });
        if (currentSock === sock) currentSock = null;

        if (shuttingDown) return;

        if (statusCode === DisconnectReason.loggedOut) {
            console.log('🚪 تم تسجيل الخروج. جاري حذف الجلسة، شغّل البوت من جديد.');
            try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
            process.exit(0);
        }

        if (statusCode === DisconnectReason.connectionReplaced) {
            console.log('⚠️ الجلسة اتفتحت من مكان تاني. اقفل النسخة التانية وبعدين شغّل البوت.');
            process.exit(1);
        }

        if (statusCode === DisconnectReason.restartRequired) {
            console.log('🔄 مطلوب إعادة تشغيل الاتصال...');
            scheduleRestart(1000);
            return;
        }

        reconnectAttempts++;
        const delay = Math.min(2000 * reconnectAttempts, 30000);
        console.log(`⏳ إعادة محاولة الاتصال بعد ${delay}ms... (محاولة ${reconnectAttempts})`);
        scheduleRestart(delay);
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            try {
                await handleMessage(sock, msg);
            } catch (err) {
                console.error('❌ خطأ في الرد:', err.message);
            }
        }
    });
}

// ═══════════════ إغلاق نظيف ═══════════════
function shutdown(signal) {
    if (shuttingDown) process.exit(0);
    shuttingDown = true;
    console.log(`\n🛑 استقبلت ${signal}، جاري الإغلاق...`);
    clearTimeout(reconnectTimer);
    try { currentSock?.end(undefined); } catch {}
    setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (err) => {
    console.error('⚠️ unhandledRejection:', err?.message || err);
});

safeStart();
