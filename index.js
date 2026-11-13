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

const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const THUMB_PATH = path.join(__dirname, 'media', 'kaido.png');
const SOURCE_URL = 'https://whatsapp.com';
const ALLOWED_CHATS = [];
const logger = pino({ level: 'silent' });

let thumbnail = undefined;
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

let currentSock = null;
let pairingPhone = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let shuttingDown = false;
let starting = false;
let waVersion = null;
global.botTurbo = false;

const isLinked = (creds) => Boolean(creds?.registered || creds?.account);

const groupMetaCache = new Map();
const GROUP_META_TTL = 60 * 1000; 

async function getGroupMetadata(sock, jid) {
    if (!global.botTurbo) return sock.groupMetadata(jid);
    const cached = groupMetaCache.get(jid);
    if (cached && Date.now() - cached.ts < GROUP_META_TTL) return cached.data;
    const data = await sock.groupMetadata(jid);
    groupMetaCache.set(jid, { data, ts: Date.now() });
    return data;
}

const sentStore = new Map();
const MAX_STORED = 500;

async function send(sock, jid, content, options) {
    const sent = await sock.sendMessage(jid, content, options);
    if (sent?.key?.id && sent.message) {
        sentStore.set(sent.key.id, sent.message);
        if (sentStore.size > MAX_STORED) sentStore.delete(sentStore.keys().next().value);
    }
    return sent;
}

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
        rl.question(question, (answer) => { answered = true; rl.close(); resolve(String(answer || '').trim()); });
    });
}

async function getPhoneNumber() {
    const preset = normalizePhone(process.env.PHONE_NUMBER || process.argv[2] || '201144953155');
    if (preset) return preset;
    if (!process.stdin.isTTY) return null;
    for (let i = 0; i < 3; i++) {
        const answer = await ask('📱 أدخل رقم الواتساب (بدون +): ');
        if (answer === null) return null;
        const phone = normalizePhone(answer);
        if (phone) return phone;
    }
    return null;
}

function extractText(msg) {
    const content = normalizeMessageContent(msg?.message);
    if (!content) return '';
    return String(content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || content.videoMessage?.caption || '')
        .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '').trim();
}

const commands = new Map([
    ['تست', async (sock, jid, msg) => {
        const content = { text: '> 𝑲𝒂𝒊𝒅𝒐 𝐁𝐨𝐭 𝐢𝐬 𝐨𝐧𝐥𝐢𝐧𝐞 🌹' };
        const thumb = getThumbnail();
        if (thumb) {
            try {
                await send(sock, jid, {
                    ...content,
                    contextInfo: { externalAdReply: { title: '𝑲𝒂𝒊𝒅𝒐 𝐁𝐎𝐓', body: '𝑲𝒂𝒊𝒅𝒐 𝐒𝐘𝐒𝐓𝐄𝐌', thumbnail: thumb, mediaType: 2, sourceUrl: SOURCE_URL, renderLargerThumbnail: false, showAdAttribution: false } }
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
        await send(sock, jid, { text: `🚀 *تم تفعيل وضع الصاروخ بنجاح!*\n\n> ⚡ تم تفعيل cache لميتاداتا الجروبات.\n> 🔥 الأوامر بقت أسرع فعلياً.` }, { quoted: msg });
    }],

    ['.فحص', async (sock, jid, msg) => {
        const start = performance.now();
        let ok = true;
        try { await sock.fetchStatus(jid); } catch (err) { ok = false; }
        const latency = (performance.now() - start).toFixed(2);
        if (!ok) return await send(sock, jid, { text: `⚠️ *فشل القياس*` }, { quoted: msg });
        const turboLine = global.botTurbo ? `\n> 🚀 وضع الصاروخ مفعّل` : '';
        await send(sock, jid, { text: `⚡ *زمن استجابة السيرفر الحقيقي:*\n> ${latency} ms${turboLine}` }, { quoted: msg });
    }],

    ['.زرف', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ هذا الأمر يعمل في الجروبات فقط!' }, { quoted: msg });
        const senderId = msg.key.participant;
        if (!senderId) return;
        try {
            const groupMetadata = await getGroupMetadata(sock, jid);
            const participants = groupMetadata.participants || [];
            const botNumber = sock.user?.id?.split(':')[0].split('@')[0] || '';
            const botLidNumber = sock.user?.lid ? sock.user.lid.split('@')[0] : '';
            const senderNum = senderId.split('@')[0];
            let isSenderAdmin = false, isBotAdmin = false;
            const adminsToDemote = [];
            for (const p of participants) {
                const isAdmin = p.admin === 'admin' || p.admin === 'superadmin';
                if (!isAdmin) continue;
                const pIdNum = p.id.split('@')[0], pLidNum = p.lid ? p.lid.split('@')[0] : '';
                if (pIdNum === senderNum || pLidNum === senderNum) isSenderAdmin = true;
                if (pIdNum === botNumber || pLidNum === botNumber || pIdNum === botLidNumber || pLidNum === botLidNumber) isBotAdmin = true;
                if (p.admin === 'admin') {
                    const isBot = pIdNum === botNumber || pLidNum === botNumber || pIdNum === botLidNumber || pLidNum === botLidNumber;
                    const isSender = pIdNum === senderNum || pLidNum === senderNum;
                    if (!isBot && !isSender) adminsToDemote.push(p.id);
                }
            }
            if (!isSenderAdmin) return await send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });
            if (!isBotAdmin) return await send(sock, jid, { text: '❌ يجب أن ترفعني (البوت) مشرفاً أولاً!' }, { quoted: msg });
            if (adminsToDemote.length > 0) await sock.groupParticipantsUpdate(jid, adminsToDemote, 'demote');
            if (getThumbnail()) await sock.updateProfilePicture(jid, { url: THUMB_PATH });
            await sock.groupUpdateDescription(jid, 'عمكم كايدو 🩸');
            await sock.groupSettingUpdate(jid, 'announcement');
            groupMetaCache.delete(jid);
            const scaryMessage = `*╭─━━━━━ 🩸 ━━━━━─╮*\n*┃ 🥀 عًمِڪْ ڪْأيِدِوٌ 🥀*\n*┃*\n*┃  𝑲𝒂𝒊𝒅𝒐 𝑩𝑶𝑻 𝑯𝒂𝒄𝒌𝒆𝒅*\n*┃  𝑮𝒓𝒐𝒖𝒑 𝑵𝒐𝒘 𝑳𝒐𝒄𝒌𝒆𝒅*\n*╰─━━━━━ 🩸 ━━━━━─╯*\n\n*⚠️ تم سحب إشراف الجميع ⚠️*\n*ممنوع إرسال الرسائل هنا*\n*إلا لعمكم كايدو..*\n*عًمِڪْ ڪْأيِدِوٌ وٌألَأّ 🥀🩸*`;
            await send(sock, jid, { text: scaryMessage });
        } catch (err) { console.error('❌ خطأ في الزرف:', err.message); }
    }]
]);

async function handleMessage(sock, msg) {
    const jid = msg?.key?.remoteJid;
    if (!msg?.message || !jid || jid === 'status@broadcast') return;
    if (msg.key.fromMe) return;
    if (sentStore.has(msg.key.id)) return;

    const text = extractText(msg);
    const command = commands.get(text);
    if (!command) return;

    console.log(`📥 أمر: [${text}] من ${jid}`);
    if (ALLOWED_CHATS.length && !ALLOWED_CHATS.includes(jid)) return;
    await command(sock, jid, msg);
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
        if (!pairingPhone) process.exit(1);
    }
    if (!waVersion) { try { const { version, isLatest } = await fetchLatestBaileysVersion(); if (isLatest) waVersion = version; } catch {} }
    const sock = makeWASocket({
        ...(waVersion ? { version: waVersion } : {}),
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        logger, browser: Browsers.ubuntu('Chrome'), syncFullHistory: false, markOnlineOnConnect: false,
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
