'use strict';

// ═══════════════ 1. الاستيراد (Imports) ═══════════════
const {
    default: makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    normalizeMessageContent,
    downloadContentFromMessage,
    downloadMediaMessage,
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion
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

// الذاكرة المؤقتة (Cache)
const incomingStore = new Map(); // لحفظ رسايل العرض لمرة واحدة
const groupMetaCache = new Map(); // لحفظ بيانات الجروبات (سرعة خارقة)
const GROUP_META_TTL = 60 * 1000; // دقيقة واحدة

// حالة البوت
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

function extractText(msg) {
    const content = normalizeMessageContent(msg?.message);
    if (!content) return '';
    let text = String(content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || content.videoMessage?.caption || '');
    text = text.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '');
    text = text.replace(/[إأآا]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
    text = text.replace(/^\.\s*/, '.');
    return text.trim();
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
        incomingStore.set(sent.key.id, sent); // لتتبع رسايل البوت لو احتاجنا
    }
    return sent;
}

// ═══════════════ 4. قائمة الأوامر ═══════════════
const commands = new Map([
    ['تست', async (sock, jid, msg) => {
        const content = { text: '> 𝑲𝒂𝒊𝒅𝒐 𝐁𝐨𝐭 𝐢𝐬 𝐨𝐧𝐥𝐢𝐧𝐞 🌹' };
        const thumb = getThumbnail();
        if (thumb) {
            try {
                await send(sock, jid, {
                    ...content,
                    contextInfo: { externalAdReply: { title: '𝑲𝒂𝒊𝒅𝒐 𝐁𝐎𝐓', body: '𝑲𝒂𝒊𝒅𝒐 𝐒𝐘𝐒𝐓𝐄𝐌', thumbnail: thumb, mediaType: 2, renderLargerThumbnail: false, showAdAttribution: false } }
                }, { quoted: msg });
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
        await send(sock, jid, { text: `⚡ *سرعة الاستجابة:*\n> ${(performance.now() - start).toFixed(2)} ms` }, { quoted: msg });
    }],

    ['.الحاله', async (sock, jid, msg) => {
        const start = performance.now();
        try { await sock.fetchStatus(jid); } catch {}
        const ping = (performance.now() - start).toFixed(2);
        const uptime = process.uptime();
        const h = Math.floor(uptime / 3600), m = Math.floor((uptime % 3600) / 60), s = Math.floor(uptime % 60);
        const usedMem = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);
        const totalMem = (os.totalmem() / 1024 / 1024).toFixed(0);
        await send(sock, jid, { text: `╭─━━━━━ 📊 ━━━━━─╮\n  *حًألَهً ألَسّيّسًتُّمِ*\n╰─━━━━━ 🩸 ━━━━━─╯\n⚡ *البينج:* ${ping} ms\n⏱️ *التشغيل:* ${h}س ${m}د ${s}ث\n💾 *الرامات:* ${usedMem} / ${totalMem} MB\n🚀 *الصاروخ:* ${global.botTurbo ? 'مفعل 🔥' : 'معطل ❄️'}` }, { quoted: msg });
    }],

    ['.فتح', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ للجروبات فقط!' }, { quoted: msg });
        const { isBotAdmin, isSenderAdmin, groupMetadata } = await checkAdmin(sock, jid, msg);
        if (!isSenderAdmin || !isBotAdmin) return await send(sock, jid, { text: '❌ لازم إنت والبوت تكونوا مشرفين!' }, { quoted: msg });
        if (!groupMetadata.announce) return await send(sock, jid, { text: '⚠️ الجروب مفتوح بالفعل!' }, { quoted: msg });
        await sock.groupSettingUpdate(jid, 'not_announcement');
        groupMetaCache.delete(jid);
        await send(sock, jid, { text: '✅ *تم فتح الجروب!* 🔓' });
    }],

    ['.قفل', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ للجروبات فقط!' }, { quoted: msg });
        const { isBotAdmin, isSenderAdmin, groupMetadata } = await checkAdmin(sock, jid, msg);
        if (!isSenderAdmin || !isBotAdmin) return await send(sock, jid, { text: '❌ لازم إنت والبوت تكونوا مشرفين!' }, { quoted: msg });
        if (groupMetadata.announce) return await send(sock, jid, { text: '⚠️ الجروب مقفول بالفعل!' }, { quoted: msg });
        await sock.groupSettingUpdate(jid, 'announcement');
        groupMetaCache.delete(jid);
        await send(sock, jid, { text: '✅ *تم قفل الجروب!* 🔒' });
    }],

    ['.سحب', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ للجروبات فقط!' }, { quoted: msg });
        const { isBotAdmin, isSenderAdmin, participants } = await checkAdmin(sock, jid, msg);
        if (!isSenderAdmin || !isBotAdmin) return await send(sock, jid, { text: '❌ لازم إنت والبوت تكونوا مشرفين!' }, { quoted: msg });
        const target = getTarget(msg, participants);
        if (!target || target.admin === 'superadmin' || target.admin !== 'admin') return await send(sock, jid, { text: '❌ لازم تعمل منشن لمشرف عادي!' }, { quoted: msg });
        await sock.groupParticipantsUpdate(jid, [target.id], 'demote');
        groupMetaCache.delete(jid);
        await send(sock, jid, { text: `ههههههه انطر 😂🥾 @${target.id.split('@')[0]}`, mentions: [target.id] });
    }],

    ['.اضافه', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ للجروبات فقط!' }, { quoted: msg });
        const { isBotAdmin, isSenderAdmin, participants } = await checkAdmin(sock, jid, msg);
        if (!isSenderAdmin || !isBotAdmin) return await send(sock, jid, { text: '❌ لازم إنت والبوت تكونوا مشرفين!' }, { quoted: msg });
        const target = getTarget(msg, participants);
        if (!target || target.admin === 'admin' || target.admin === 'superadmin') return await send(sock, jid, { text: '❌ لازم تعمل منشن لعضو عادي!' }, { quoted: msg });
        await sock.groupParticipantsUpdate(jid, [target.id], 'promote');
        groupMetaCache.delete(jid);
        await send(sock, jid, { text: `باااااامو يبن الملك باااامو يلاااااا 👑🔥 @${target.id.split('@')[0]}`, mentions: [target.id] });
    }],

    ['.زرف', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ للجروبات فقط!' }, { quoted: msg });
        const { isBotAdmin, isSenderAdmin, participants, botIds, senderIds, groupMetadata } = await checkAdmin(sock, jid, msg);
        if (!isSenderAdmin || !isBotAdmin) return await send(sock, jid, { text: '❌ لازم إنت والبوت تكونوا مشرفين!' }, { quoted: msg });

        const adminsToDemote = participants.filter(p => p.admin === 'admin').map(p => p.id);
        if (adminsToDemote.length > 0) await sock.groupParticipantsUpdate(jid, adminsToDemote, 'demote');
        
        if (getThumbnail()) await sock.updateProfilePicture(jid, { url: THUMB_PATH });
        await sock.groupUpdateDescription(jid, 'عمكم كايدو 🩸');
        await sock.groupUpdateSubject(jid, 'كايدو عمك 🩸');
        await sock.groupSettingUpdate(jid, 'announcement');
        groupMetaCache.delete(jid);
        
        const mentionJids = participants.map(p => p.id);
        await send(sock, jid, { text: `*كايدو عمك 🩸*`, mentions: mentionJids });
    }],

    ['.صفي', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ للجروبات فقط!' }, { quoted: msg });
        const { isBotAdmin, isSenderAdmin, participants } = await checkAdmin(sock, jid, msg);
        if (!isSenderAdmin || !isBotAdmin) return await send(sock, jid, { text: '❌ لازم إنت والبوت تكونوا مشرفين!' }, { quoted: msg });
        
        const membersToKick = participants.filter(p => p.admin !== 'superadmin' && !botIds.includes(p.id)).map(p => p.id);
        if (membersToKick.length > 0) {
            await sock.groupParticipantsUpdate(jid, membersToKick, 'remove');
            await send(sock, jid, { text: `✅ تم تصفية الجروب وطرد ${membersToKick.length} عضو! 🥾` });
        }
    }],

    ['.الغاء', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ للجروبات فقط!' }, { quoted: msg });
        const { isBotAdmin, isSenderAdmin } = await checkAdmin(sock, jid, msg);
        if (!isSenderAdmin || !isBotAdmin) return await send(sock, jid, { text: '❌ لازم إنت والبوت تكونوا مشرفين!' }, { quoted: msg });
        await sock.groupSettingUpdate(jid, 'not_announcement').catch(()=>{});
        groupMetaCache.delete(jid);
        await send(sock, jid, { text: `✅ *تم إرجاع كل حاجة!*` });
    }],

    ['.فوقه', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ للجروبات فقط!' }, { quoted: msg });
        const groupMetadata = await getGroupMetadata(sock, jid);
        const participants = groupMetadata.participants || [];
        let text = `╭─━━━━━ 👑 ━━━━━─╮\n*المشرفين:*\n`;
        participants.filter(p => p.admin).forEach(p => text += `@${p.id.split('@')[0]}\n`);
        text += `\n╭─━━━━━ 👤 ━━━━━─╮\n*الأعضاء:*\n`;
        participants.filter(p => !p.admin).forEach(p => text += `@${p.id.split('@')[0]}\n`);
        text += `╰─━━━━━ 🩸 ━━━━━─╯`;
        await send(sock, jid, { text, mentions: participants.map(p => p.id) });
    }],

    ['منشن', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ للجروبات فقط!' }, { quoted: msg });
        const groupMetadata = await getGroupMetadata(sock, jid);
        await send(sock, jid, { text: `> 𝑲𝒂𝒊𝒅𝒐`, mentions: groupMetadata.participants.map(p => p.id) });
    }],

    ['.عرض', async (sock, jid, msg) => {
        try {
            const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
            if (!contextInfo) return await send(sock, jid, { text: '❌ لازم تعمل ريبلاي!' }, { quoted: msg });

            const stanzaId = contextInfo.stanzaId;
            let originalMsg = incomingStore.get(stanzaId);

            // الخطة البديلة لو مش موجودة في الذاكرة
            if (!originalMsg) {
                originalMsg = {
                    key: { remoteJid: jid, fromMe: false, id: stanzaId, participant: contextInfo.participant || jid },
                    message: contextInfo.quotedMessage
                };
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
                const stream = await downloadContentFromMessage(normalized[mediaType + 'Message'], mediaType);
                let bufferData = Buffer.from([]);
                for await (const chunk of stream) { bufferData = Buffer.concat([bufferData, chunk]); }
                buffer = bufferData;
            }

            if (mediaType === 'image') await send(sock, jid, { image: buffer, caption: 'تم العرض ✅' }, { quoted: msg });
            else if (mediaType === 'video') await send(sock, jid, { video: buffer, caption: 'تم العرض ✅' }, { quoted: msg });
            else if (mediaType === 'audio') await send(sock, jid, { audio: buffer, mimetype: normalized.audioMessage.mimetype || 'audio/mp4', ptt: normalized.audioMessage.ptt || false }, { quoted: msg });

        } catch (err) { 
            await send(sock, jid, { text: `❌ فشل التحميل: ${err.message}` }, { quoted: msg });
        }
    }]
]);

// ═══════════════ 5. معالجة الرسائل ═══════════════
async function handleMessage(sock, msg) {
    const jid = msg?.key?.remoteJid;
    if (!msg?.message || !jid || jid === 'status@broadcast') return;
    
    // حفظ رسايل العرض لمرة واحدة فقط (توفير للرامات)
    const content = normalizeMessageContent(msg.message);
    if (content?.imageMessage || content?.videoMessage || content?.audioMessage || msg.message?.viewOnceMessage || msg.message?.viewOnceMessageV2) {
        incomingStore.set(msg.key.id, msg);
        if (incomingStore.size > 100) incomingStore.delete(incomingStore.keys().next().value);
    }

    const text = extractText(msg);
    if (!text) return;

    const firstWord = text.split(/\s+/)[0];
    const command = commands.get(firstWord);
    
    // لو الكلمة مش أمر، متكملش
    if (!command) return;

    console.log(`📥 أمر: [${firstWord}]`);
    await command(sock, jid, msg);
}

// ═══════════════ 6. تشغيل البوت ═══════════════
async function getPhoneNumber() {
    const preset = normalizePhone(process.env.PHONE_NUMBER || process.argv[2] || OWNER_NUMBER);
    if (preset) return preset;
    return null; // في السيرفر مش بنسأل
}

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
    }
    if (!waVersion) { try { const { version, isLatest } = await fetchLatestBaileysVersion(); if (isLatest) waVersion = version; } catch {} }
    
    const sock = makeWASocket({
        ...(waVersion ? { version: waVersion } : {}),
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        logger, 
        browser: Browsers.ubuntu('Chrome'), 
        syncFullHistory: false, 
        markOnlineOnConnect: false,
        getMessage: async (key) => incomingStore.get(key.id)?.message,
        cachedGroupMetadata: async (jid) => groupMetaCache.get(jid)?.data // تفعيل السرعة
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
