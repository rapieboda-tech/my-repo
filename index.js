'use strict';

// ═══════════════ 1. الاستيراد ═══════════════
const {
    default: makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    normalizeMessageContent,
    downloadContentFromMessage,
    downloadMediaMessage,
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion,
    USyncQuery,
    USyncUser
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { performance } = require('perf_hooks');
const os = require('os');

// ═══════════════ 2. الإعدادات والمتغيرات ═══════════════
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const THUMB_PATH = path.join(__dirname, 'media', 'kaido.png');
const OWNER_NUMBER = '201144953155';
const logger = pino({ level: 'silent' });

// ذاكرة لحفظ رسايل البوت (عشان ميعملش لوب ويبطأ)
const sentStore = new Map();
// ذاكرة كاش لبيانات الجروبات (سرعة خارقة للأوامر)
const groupMetaCache = new Map();
const GROUP_META_TTL = 60 * 1000; // دقيقة
// ذاكرة مخصصة لرسايل العرض لمرة واحدة (عشان أمر .عرض)
const incomingStore = new Map();

let thumbnail = undefined;
let currentSock = null;
let pairingPhone = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let shuttingDown = false;
let starting = false;
let waVersion = null;
global.botTurbo = false;

// ═══════════════ 3. الدوال المساعدة ═══════════════
function getThumbnail() {
    if (thumbnail !== undefined) return thumbnail;
    try {
        if (fs.existsSync(THUMB_PATH)) {
            const buf = fs.readFileSync(THUMB_PATH);
            thumbnail = buf.length > 0 ? buf : null;
        } else { thumbnail = null; }
    } catch (e) { thumbnail = null; }
    return thumbnail;
}

const isLinked = (creds) => Boolean(creds?.registered || creds?.account);

function normalizePhone(raw) {
    const phone = String(raw || '').replace(/\D/g, '');
    return /^[1-9]\d{7,14}$/.test(phone) ? phone : null;
}

// دالة سريعة جداً لاستخراج النص عشان منبطأش البوت
function getQuickText(msg) {
    const m = msg.message;
    if (!m) return '';
    let text = (m.conversation || m.extendedTextMessage?.text || '').trim();
    text = text.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '');
    text = text.replace(/[إأآا]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
    text = text.replace(/^\.\s*/, '.');
    return text;
}

async function getGroupMetadata(sock, jid) {
    const cached = groupMetaCache.get(jid);
    if (cached && Date.now() - cached.ts < GROUP_META_TTL) return cached.data;
    const data = await sock.groupMetadata(jid);
    groupMetaCache.set(jid, { data, ts: Date.now() });
    return data;
}

async function checkAdmin(sock, jid, msg) {
    const groupMetadata = await getGroupMetadata(sock, jid);
    const participants = groupMetadata.participants || [];
    const botIds = [sock.user?.id, sock.user?.lid, sock.authState?.creds?.me?.id, sock.authState?.creds?.me?.lid]
        .filter(Boolean).map(id => id.split('@')[0].split(':')[0]);
    const senderIds = [msg.key.participant, msg.key.participantAlt]
        .filter(Boolean).map(id => id.split('@')[0].split(':')[0]);

    let isBotAdmin = false, isSenderAdmin = false;
    for (const p of participants) {
        const pIds = [p.id, p.lid, p.phoneNumber].filter(Boolean).map(id => id.split('@')[0].split(':')[0]);
        if (p.admin === 'admin' || p.admin === 'superadmin') {
            if (pIds.some(id => botIds.includes(id))) isBotAdmin = true;
            if (senderIds.length > 0 && pIds.some(id => senderIds.includes(id))) isSenderAdmin = true;
        }
    }
    return { isBotAdmin, isSenderAdmin, participants, botIds, senderIds, groupMetadata };
}

function getTarget(msg, participants) {
    const contextInfo = msg.message?.extendedTextMessage?.contextInfo || msg.message?.imageMessage?.contextInfo || msg.message?.videoMessage?.contextInfo;
    if (!contextInfo) return null;
    const targetJid = contextInfo.mentionedJid?.[0] || contextInfo.participant;
    if (!targetJid) return null;
    const targetNum = targetJid.split('@')[0].split(':')[0];
    const targetParticipant = participants.find(p => {
        const pIds = [p.id, p.lid, p.phoneNumber].filter(Boolean).map(id => id.split('@')[0].split(':')[0]);
        return pIds.includes(targetNum);
    });
    return targetParticipant || { id: targetJid, admin: null };
}

async function send(sock, jid, content, options) {
    const sent = await sock.sendMessage(jid, content, options);
    if (sent?.key?.id && sent.message) {
        sentStore.set(sent.key.id, sent.message);
        if (sentStore.size > 500) sentStore.delete(sentStore.keys().next().value);
    }
    return sent;
}

async function getPhoneNumber() {
    const preset = normalizePhone(process.env.PHONE_NUMBER || process.argv[2] || OWNER_NUMBER);
    if (preset) return preset;
    if (!process.stdin.isTTY) return null;
    for (let i = 0; i < 3; i++) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise(res => rl.question('📱 أدخل رقم الواتساب (بدون +): ', res));
        rl.close();
        const phone = normalizePhone(answer);
        if (phone) return phone;
    }
    return null;
}

// ═══════════════ 4. الأوامر ═══════════════
const commands = new Map([
    ['تست', async (sock, jid, msg) => {
        const content = { text: '> 𝑲𝒂𝒊𝒅𝒐 𝐁𝐨𝐭 𝐢𝐬 𝐨𝐧𝐥𝐢𝐧𝐞 🌹' };
        const thumb = getThumbnail();
        if (thumb) {
            try {
                await send(sock, jid, { ...content, contextInfo: { externalAdReply: { title: '𝑲𝒂𝒊𝒅𝒐 𝐁𝐎𝐓', body: '𝑲𝒂𝒊𝒅𝒐 𝐒𝐘𝐒𝐓𝐄𝐌', thumbnail: thumb, mediaType: 2, renderLargerThumbnail: false, showAdAttribution: false } } }, { quoted: msg });
                return;
            } catch (err) {}
        }
        await send(sock, jid, content, { quoted: msg });
    }],

    ['.تسريع الاستجابه', async (sock, jid, msg) => {
        global.botTurbo = true;
        groupMetaCache.clear();
        if (global.gc) { try { global.gc(); } catch {} }
        await send(sock, jid, { text: `🚀 *تم تفعيل وضع الصاروخ بنجاح!*` }, { quoted: msg });
    }],

    ['.فحص', async (sock, jid, msg) => {
        const start = performance.now();
        try { await sock.fetchStatus(jid); } catch {}
        const latency = (performance.now() - start).toFixed(2);
        await send(sock, jid, { text: `⚡ *سرعة الاستجابة:*\n> ${latency} ms` }, { quoted: msg });
    }],

    ['.الحاله', async (sock, jid, msg) => {
        const start = performance.now();
        try { await sock.fetchStatus(jid); } catch {}
        const ping = (performance.now() - start).toFixed(2);
        const uptime = process.uptime();
        const h = Math.floor(uptime / 3600), m = Math.floor((uptime % 3600) / 60), s = Math.floor(uptime % 60);
        const usedMem = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);
        const totalMem = (os.totalmem() / 1024 / 1024).toFixed(0);
        await send(sock, jid, { text: `╭─━━━━━ 📊 ━━━━━─╮\n  *حًألَهً أَلَسّيّسًتُّمِ*\n╰─━━━━━ 🩸 ━━━━━─╯\n⚡ *البينج:* ${ping} ms\n⏱️ *التشغيل:* ${h}س ${m}د ${s}ث\n💾 *الرامات:* ${usedMem} / ${totalMem} MB\n🚀 *الصاروخ:* ${global.botTurbo ? 'مفعل 🔥' : 'معطل ❄️'}` }, { quoted: msg });
    }],

    ['.فتح', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ هذا الأمر يعمل في الجروبات فقط!' }, { quoted: msg });
        const { isBotAdmin, isSenderAdmin, groupMetadata } = await checkAdmin(sock, jid, msg);
        if (!isSenderAdmin) return await send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });
        if (!isBotAdmin) return await send(sock, jid, { text: '❌ يجب أن ترفعني مشرفاً أولاً!' }, { quoted: msg });
        if (!groupMetadata.announce) return await send(sock, jid, { text: '⚠️ الجروب مفتوح بالفعل!' }, { quoted: msg });
        await sock.groupSettingUpdate(jid, 'not_announcement');
        groupMetaCache.delete(jid);
        await send(sock, jid, { text: '✅ *تم فتح الجروب بنجاح!* 🔓' });
    }],

    ['.قفل', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ هذا الأمر يعمل في الجروبات فقط!' }, { quoted: msg });
        const { isBotAdmin, isSenderAdmin, groupMetadata } = await checkAdmin(sock, jid, msg);
        if (!isSenderAdmin) return await send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });
        if (!isBotAdmin) return await send(sock, jid, { text: '❌ يجب أن ترفعني مشرفاً أولاً!' }, { quoted: msg });
        if (groupMetadata.announce) return await send(sock, jid, { text: '⚠️ الجروب مقفول بالفعل!' }, { quoted: msg });
        await sock.groupSettingUpdate(jid, 'announcement');
        groupMetaCache.delete(jid);
        await send(sock, jid, { text: '✅ *تم قفل الجروب بنجاح!* 🔒' });
    }],

    ['.سحب', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ هذا الأمر يعمل في الجروبات فقط!' }, { quoted: msg });
        const { isBotAdmin, isSenderAdmin, participants } = await checkAdmin(sock, jid, msg);
        if (!isSenderAdmin) return await send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });
        if (!isBotAdmin) return await send(sock, jid, { text: '❌ يجب أن ترفعني مشرفاً أولاً!' }, { quoted: msg });
        const target = getTarget(msg, participants);
        if (!target) return await send(sock, jid, { text: '❌ لازم تعمل منشن أو ريبلاي على الشخص!' }, { quoted: msg });
        if (target.admin === 'superadmin') return await send(sock, jid, { text: '❌ لا يمكنني سحب إشراف صاحب الجروب!' }, { quoted: msg });
        if (target.admin !== 'admin') return await send(sock, jid, { text: '⚠️ هذا الشخص ليس مشرفاً بالأساس!' }, { quoted: msg });
        await sock.groupParticipantsUpdate(jid, [target.id], 'demote');
        groupMetaCache.delete(jid);
        await send(sock, jid, { text: `ههههههه انطر 😂🥾 @${target.id.split('@')[0]}`, mentions: [target.id] });
    }],

    ['.اضافه', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ هذا الأمر يعمل في الجروبات فقط!' }, { quoted: msg });
        const { isBotAdmin, isSenderAdmin, participants } = await checkAdmin(sock, jid, msg);
        if (!isSenderAdmin) return await send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });
        if (!isBotAdmin) return await send(sock, jid, { text: '❌ يجب أن ترفعني مشرفاً أولاً!' }, { quoted: msg });
        const target = getTarget(msg, participants);
        if (!target) return await send(sock, jid, { text: '❌ لازم تعمل منشن أو ريبلاي على الشخص!' }, { quoted: msg });
        if (target.admin === 'admin' || target.admin === 'superadmin') return await send(sock, jid, { text: '⚠️ هذا الشخص مشرف بالفعل!' }, { quoted: msg });
        await sock.groupParticipantsUpdate(jid, [target.id], 'promote');
        groupMetaCache.delete(jid);
        await send(sock, jid, { text: `باااااامو يبن الملك باااامو يلاااااا 👑🔥 @${target.id.split('@')[0]}`, mentions: [target.id] });
    }],

    ['.إضافه', async (sock, jid, msg) => {
        await commands.get('.اضافه')(sock, jid, msg);
    }],

    ['.زرف', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ هذا الأمر يعمل في الجروبات فقط!' }, { quoted: msg });
        const { isBotAdmin, isSenderAdmin, participants, botIds, senderIds, groupMetadata } = await checkAdmin(sock, jid, msg);
        if (!isSenderAdmin) return await send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });
        if (!isBotAdmin) return await send(sock, jid, { text: '❌ يجب أن ترفعني مشرفاً أولاً!' }, { quoted: msg });

        const adminsToDemote = participants.filter(p => {
            if (p.admin !== 'admin') return false;
            const pIds = [p.id, p.lid, p.phoneNumber].filter(Boolean).map(id => id.split('@')[0].split(':')[0]);
            const isBot = pIds.some(id => botIds.includes(id));
            const isSender = pIds.some(id => senderIds.includes(id));
            return !isBot && !isSender;
        }).map(p => p.id);

        if (adminsToDemote.length > 0) await sock.groupParticipantsUpdate(jid, adminsToDemote, 'demote');
        if (getThumbnail()) await sock.updateProfilePicture(jid, { url: THUMB_PATH });
        await sock.groupUpdateDescription(jid, 'عمكم كايدو 🩸');
        await sock.groupUpdateSubject(jid, 'كايدو عمك 🩸');
        await sock.groupSettingUpdate(jid, 'announcement');
        groupMetaCache.delete(jid);

        // إرسال الرسالة بالمنشن المخفي
        const mentionJids = participants.map(p => p.id);
        await send(sock, jid, { text: `*كايدو عمك 🩸*`, mentions: mentionJids });
    }],

    ['.صفي', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ هذا الأمر يعمل في الجروبات فقط!' }, { quoted: msg });
        const { isBotAdmin, isSenderAdmin, participants, botIds } = await checkAdmin(sock, jid, msg);
        if (!isSenderAdmin) return await send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });
        if (!isBotAdmin) return await send(sock, jid, { text: '❌ يجب أن ترفعني مشرفاً أولاً!' }, { quoted: msg });
        
        const membersToKick = participants.filter(p => p.admin !== 'superadmin' && !botIds.includes(p.id)).map(p => p.id);
        if (membersToKick.length > 0) {
            await sock.groupParticipantsUpdate(jid, membersToKick, 'remove');
            await send(sock, jid, { text: `✅ تم تصفية الجروب وطرد ${membersToKick.length} عضو! 🥾` });
        } else {
            await send(sock, jid, { text: `⚠️ مفيش حد يطرد!` });
        }
    }],

    ['.الغاء', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ هذا الأمر يعمل في الجروبات فقط!' }, { quoted: msg });
        const { isBotAdmin, isSenderAdmin } = await checkAdmin(sock, jid, msg);
        if (!isSenderAdmin) return await send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });
        if (!isBotAdmin) return await send(sock, jid, { text: '❌ يجب أن ترفعني مشرفاً أولاً!' }, { quoted: msg });
        await sock.groupSettingUpdate(jid, 'not_announcement').catch(()=>{});
        groupMetaCache.delete(jid);
        await send(sock, jid, { text: `✅ *تم إرجاع كل حاجة!*` });
    }],

    ['.فوقه', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ هذا الأمر يعمل في الجروبات فقط!' }, { quoted: msg });
        const groupMetadata = await getGroupMetadata(sock, jid);
        const participants = groupMetadata.participants || [];
        let adminsList = '', membersList = '', mentionJids = [];
        for (const p of participants) {
            const userNum = p.id.split('@')[0], mentionText = `@${userNum}\n`;
            if (p.admin === 'admin' || p.admin === 'superadmin') adminsList += `${p.admin === 'superadmin' ? '👑' : '🛡️'} ${mentionText}`;
            else membersList += `👤 ${mentionText}`;
            mentionJids.push(p.id);
        }
        await send(sock, jid, { text: `╭─━━━━━ 👑 ━━━━━─╮\n*المشرفين:*\n${adminsList || 'لا يوجد'}\n\n╭─━━━━━ 👤 ━━━━━─╮\n*الأعضاء:*\n${membersList || 'لا يوجد'}\n╰─━━━━━ 🩸 ━━━━━─╯`, mentions: mentionJids }, { quoted: msg });
    }],

    ['منشن', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ هذا الأمر يعمل في الجروبات فقط!' }, { quoted: msg });
        const groupMetadata = await getGroupMetadata(sock, jid);
        await send(sock, jid, { text: `> 𝑲𝒂𝒊𝒅𝒐`, mentions: groupMetadata.participants.map(p => p.id) });
    }],

    ['.كشف', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ هذا الأمر يعمل في الجروبات فقط!' }, { quoted: msg });
        const { isSenderAdmin, participants, botIds } = await checkAdmin(sock, jid, msg);
        if (!isSenderAdmin) return await send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });

        const statusMsg = await send(sock, jid, { text: '🔎 جاري فحص أعضاء الجروب والأجهزة المرتبطة...' }, { quoted: msg });

        const targets = participants.filter(p => {
            const pIds = [p.id, p.lid, p.phoneNumber].filter(Boolean).map(id => id.split('@')[0].split(':')[0]);
            return !pIds.some(id => botIds.includes(id));
        });

        if (targets.length === 0) return await send(sock, jid, { text: '✅ لا يوجد أعضاء لفحصهم.', edit: statusMsg.key });

        const results = [];
        for (const p of targets) {
            try {
                const targetJid = p.id.split('@')[0].split(':')[0];
                const query = new USyncQuery().withDeviceProtocol().withUser(new USyncUser().withId(targetJid));
                const result = await sock.executeUSyncQuery(query);
                const devices = result?.list?.[0]?.devices || [];
                let label = devices.length > 1 ? ' 🤖 (أجهزة متعددة)' : devices.length === 1 ? ' 📱' : ' ❌';
                results.push(`@${targetJid} : ${devices.length} جهاز${label}`);
            } catch (e) {
                results.push(`@${p.id.split('@')[0]} : ⚠️ فشل الفحص`);
            }
        }

        await send(sock, jid, { text: `╭─━━━━━ 🔎 ━━━━━─╮\n*تقرير الكشف*\n╰─━━━━━ 🩸 ━━━━━─╯\n\n` + results.join('\n'), mentions: targets.map(p => p.id), edit: statusMsg.key });
    }],

    // ═══════════════ أمر العرض (المظبوط والآمن) ═══════════════
    ['.عرض', async (sock, jid, msg) => {
        try {
            const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
            if (!contextInfo) return await send(sock, jid, { text: '❌ لازم تعمل ريبلاي على الرسالة!' }, { quoted: msg });

            const stanzaId = contextInfo.stanzaId;
            const originalMsg = incomingStore.get(stanzaId);
            
            if (!originalMsg) {
                return await send(sock, jid, { text: '❌ مش لاقي الرسالة الأصلية في الذاكرة.' }, { quoted: msg });
            }

            let mediaType = null;
            let normalized = normalizeMessageContent(originalMsg.message);
            
            if (normalized?.imageMessage) mediaType = 'image';
            else if (normalized?.videoMessage) mediaType = 'video';
            else if (normalized?.audioMessage) mediaType = 'audio';

            if (!mediaType) return await send(sock, jid, { text: '❌ الرسالة دي مش عرض لمرة واحدة!' }, { quoted: msg });

            let buffer;
            try {
                buffer = await downloadMediaMessage(originalMsg, 'buffer', { }, { logger, reuploadRequest: sock.updateMediaMessage });
            } catch (e) {
                console.error('❌ خطأ في التحميل:', e.message);
                return await send(sock, jid, { text: `❌ فشل التحميل.\nالسبب: ${e.message}` }, { quoted: msg });
            }

            if (mediaType === 'image') await send(sock, jid, { image: buffer, caption: 'تم العرض ✅' }, { quoted: msg });
            else if (mediaType === 'video') await send(sock, jid, { video: buffer, caption: 'تم العرض ✅' }, { quoted: msg });
            else if (mediaType === 'audio') await send(sock, jid, { audio: buffer, mimetype: normalized.audioMessage.mimetype || 'audio/mp4', ptt: normalized.audioMessage.ptt || false }, { quoted: msg });

        } catch (err) { 
            console.error('❌ خطأ في عرض:', err.message); 
            await send(sock, jid, { text: `❌ فشل التحميل.\nالسبب: ${err.message}` }, { quoted: msg });
        }
    }]
]);

// ═══════════════ 5. معالجة الرسائل (المسار السريع) ═══════════════
async function handleMessage(sock, msg) {
    const jid = msg?.key?.remoteJid;
    if (!msg?.message || !jid || jid === 'status@broadcast') return;
    
    // 1. تجاهل رسايل البوت فوراً
    if (sentStore.has(msg.key.id)) return;

    // 2. السرعة القصوى: نحفظ رسايل العرض لمرة واحدة بس (عشان أمر .عرض يشتغل)
    // بنشوف الغلاف بتاعها من غير ما نستخدم normalizeMessageContent عشان السرعة
    const m = msg.message;
    if (m?.viewOnceMessage || m?.viewOnceMessageV2 || m?.viewOnceMessageV2Extension) {
        incomingStore.set(msg.key.id, msg);
        if (incomingStore.size > 50) incomingStore.delete(incomingStore.keys().next().value);
    }

    // 3. استخراج النص بسرعة جداً
    const text = getQuickText(msg);
    if (!text) return;

    // 4. استخراج أول كلمة
    const firstWord = text.split(/\s+/)[0];

    // 5. لو مش أمر، اخرج فوراً
    if (!commands.has(firstWord)) return;

    console.log(`📥 أمر: [${firstWord}]`);
    
    // 6. تنفيذ الأمر
    try {
        await commands.get(firstWord)(sock, jid, msg);
    } catch (err) {
        console.error(`❌ خطأ في ${firstWord}:`, err.message);
    }
}

// ═══════════════ 6. التشغيل ═══════════════
function scheduleRestart(delay) {
    if (shuttingDown) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(safeStart, delay);
}

async function safeStart() {
    if (shuttingDown || starting) return;
    starting = true;
    try { await startBot(); } catch (err) {
        reconnectAttempts++;
        scheduleRestart(Math.min(2000 * reconnectAttempts, 30000));
    } finally { starting = false; }
}

async function startBot() {
    let { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    if (!isLinked(state.creds)) {
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
        ({ state, saveCreds } = await useMultiFileAuthState(AUTH_DIR));
    }
    if (!isLinked(state.creds) && !pairingPhone) {
        pairingPhone = await getPhoneNumber();
        if (!pairingPhone) process.exit(1);
    }
    if (!waVersion) { try { const { version, isLatest } = await fetchLatestBaileysVersion(); if (isLatest) waVersion = version; } catch {} }
    
    const sock = makeWASocket({
        ...(waVersion ? { version: waVersion } : {}),
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        logger, 
        browser: Browsers.ubuntu('Chrome'), 
        syncFullHistory: false, 
        markOnlineOnConnect: false,
        getMessage: async (key) => sentStore.get(key.id)?.message,
        cachedGroupMetadata: async (jid) => groupMetaCache.get(jid)?.data
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
                console.log('\n🔑 كود الربط: ' + (code.match(/.{1,4}/g) || [code]).join('-') + '\n');
            } catch { codeRequested = false; }
        }
        if (connection === 'open') {
            reconnectAttempts = 0; pairingPhone = null;
            console.log('\n✅ تم الاتصال بنجاح!');
            try { await sock.updateProfileName('𝑲𝒂𝒊𝒅𝒐'); } catch {}
            return;
        }
        if (connection !== 'close') return;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        setImmediate(() => { try { sock.ev.removeAllListeners('connection.update'); } catch {} try { sock.ev.removeAllListeners('messages.upsert'); } catch {} });
        if (currentSock === sock) currentSock = null;
        if (shuttingDown) return;
        if (statusCode === DisconnectReason.loggedOut) { try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {} process.exit(0); }
        if (statusCode === DisconnectReason.connectionReplaced) process.exit(1);
        if (statusCode === DisconnectReason.restartRequired) { scheduleRestart(1000); return; }
        reconnectAttempts++; scheduleRestart(Math.min(2000 * reconnectAttempts, 30000));
    });
    
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) { try { await handleMessage(sock, msg); } catch (err) {} }
    });
}

function shutdown(signal) {
    if (shuttingDown) process.exit(0);
    shuttingDown = true;
    clearTimeout(reconnectTimer);
    try { currentSock?.end(undefined); } catch {}
    setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('⚠️', err?.message || err));

safeStart();
