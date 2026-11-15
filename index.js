'use strict';

// ═══════════════ 1. الاستيراد ═══════════════
const {
    default: makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    downloadContentFromMessage,
    downloadMediaMessage,
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const { performance } = require('perf_hooks');
const os = require('os');

// ═══════════════ 2. الإعدادات والمتغيرات ═══════════════
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const THUMB_PATH = path.join(__dirname, 'media', 'kaido.png');
const OWNER_NUMBER = '201144953155';
const logger = pino({ level: 'silent' });

// الذاكرة المؤقتة للسرعة (بدون تخزين ميديا عشان ميبطأش)
const sentStore = new Set();
const groupMetaCache = new Map();
const GROUP_META_TTL = 5 * 60 * 1000; // 5 دقائق

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

function getQuickText(msg) {
    const m = msg.message;
    if (!m) return '';
    let text = (m.conversation || m.extendedTextMessage?.text || '').trim();
    text = text.replace(/[إأآا]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
    text = text.replace(/^\.\s*/, '.');
    return text;
}

async function getGroupMeta(sock, jid) {
    const cached = groupMetaCache.get(jid);
    if (cached && Date.now() - cached.ts < GROUP_META_TTL) return cached.data;
    const data = await sock.groupMetadata(jid);
    groupMetaCache.set(jid, { data, ts: Date.now() });
    return data;
}

async function checkAdmin(sock, jid, msg) {
    const groupMetadata = await getGroupMeta(sock, jid);
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
    if (sent?.key?.id) {
        sentStore.add(sent.key.id);
        if (sentStore.size > 500) sentStore.delete(sentStore.values().next().value);
    }
    return sent;
}

// ═══════════════ 4. الأوامر ═══════════════
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
        await send(sock, jid, { text: `🚀 *تم تفعيل وضع الصاروخ!*` }, { quoted: msg });
    }],

    ['.فحص', async (sock, jid, msg) => {
        const start = performance.now();
        try { await sock.fetchStatus(jid); } catch {}
        await send(sock, jid, { text: `⚡ *البينج:*\n> ${(performance.now() - start).toFixed(2)} ms` }, { quoted: msg });
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

    ['.إضافه', async (sock, jid, msg) => {
        await commands.get('.اضافه')(sock, jid, msg);
    }],

    ['.زرف', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ للجروبات فقط!' }, { quoted: msg });
        const { isBotAdmin, isSenderAdmin, participants, botIds, senderIds } = await checkAdmin(sock, jid, msg);
        if (!isSenderAdmin || !isBotAdmin) return await send(sock, jid, { text: '❌ لازم إنت والبوت تكونوا مشرفين!' }, { quoted: msg });

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
        
        const mentionJids = participants.map(p => p.id);
        await send(sock, jid, { text: `*كايدو عمك 🩸*`, mentions: mentionJids });
    }],

    ['.صفي', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ للجروبات فقط!' }, { quoted: msg });
        const { isBotAdmin, isSenderAdmin, participants, botIds } = await checkAdmin(sock, jid, msg);
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
        const groupMetadata = await getGroupMeta(sock, jid);
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
        const groupMetadata = await getGroupMeta(sock, jid);
        await send(sock, jid, { text: `> 𝑲𝒂𝒊𝒅𝒐`, mentions: groupMetadata.participants.map(p => p.id) });
    }],

    // ═══════════════ أمر عرض (الكود اللي إنت بعتهولي بالظبط) ═══════════════
    ['.عرض', async (sock, jid, msg) => {
        try {
            // لازم يكون فيه رد على رسالة
            const contextInfo = msg?.message?.extendedTextMessage?.contextInfo;
            const quoted = contextInfo?.quotedMessage || msg?.quoted?.message || msg?.quoted;

            if (!quoted) {
                return sock.sendMessage(jid, {
                    text: '🎀 *طريقة الاستخدام:*\n\nرد على رسالة (صورة / فيديو / صوت) View Once واكتب `.عرض`'
                }, { quoted: msg });
            }

            // ========== استخراج الرسالة الأصلية ==========
            let viewOnceMsg = quoted;

            // ندعم كل إصدارات View Once
            if (quoted.viewOnceMessage?.message) {
                viewOnceMsg = quoted.viewOnceMessage.message;
            } else if (quoted.viewOnceMessageV2?.message) {
                viewOnceMsg = quoted.viewOnceMessageV2.message;
            } else if (quoted.viewOnceMessageV2Extension?.message) {
                viewOnceMsg = quoted.viewOnceMessageV2Extension.message;
            }

            // ========== تحديد نوع الوسائط ==========
            let mediaType = null;
            let mediaMessage = null;

            if (viewOnceMsg.imageMessage) {
                mediaType = 'image';
                mediaMessage = viewOnceMsg.imageMessage;
            } else if (viewOnceMsg.videoMessage) {
                mediaType = 'video';
                mediaMessage = viewOnceMsg.videoMessage;
            } else if (viewOnceMsg.audioMessage) {
                mediaType = 'audio';
                mediaMessage = viewOnceMsg.audioMessage;
            } else if (viewOnceMsg.documentMessage) {
                mediaType = 'document';
                mediaMessage = viewOnceMsg.documentMessage;
            } else if (viewOnceMsg.stickerMessage) {
                mediaType = 'sticker';
                mediaMessage = viewOnceMsg.stickerMessage;
            }

            if (!mediaType || !mediaMessage) {
                return sock.sendMessage(jid, {
                    text: '❌ الرسالة دي مش View Once أو مفيهاش صورة/فيديو/صوت.'
                }, { quoted: msg });
            }

            // ========== تحميل الوسائط ==========
            let buffer = Buffer.from([]);

            try {
                const stream = await downloadContentFromMessage(mediaMessage, mediaType === 'sticker' ? 'sticker' : mediaType);
                for await (const chunk of stream) {
                    buffer = Buffer.concat([buffer, chunk]);
                }
            } catch (err) {
                console.error('downloadContentFromMessage failed:', err);

                // محاولة ثانية باستخدام downloadMediaMessage
                try {
                    const fullMsg = {
                        key: {
                            remoteJid: jid,
                            id: contextInfo?.stanzaId || msg.key.id,
                            participant: contextInfo?.participant
                        },
                        message: quoted
                    };

                    buffer = await downloadMediaMessage(fullMsg, 'buffer', {}, {
                        logger: console,
                        reuploadRequest: sock.updateMediaMessage
                    });
                } catch (err2) {
                    console.error('downloadMediaMessage also failed:', err2);
                    return sock.sendMessage(jid, {
                        text: '❌ مش قادر أحمل الوسائط من الرسالة دي.\nممكن الرسالة اتمسحت أو منتهية.'
                    }, { quoted: msg });
                }
            }

            if (!buffer || buffer.length < 100) {
                return sock.sendMessage(jid, {
                    text: '❌ الوسائط فاضية أو مش مكتملة.'
                }, { quoted: msg });
            }

            // ========== إرسال الوسائط ==========
            if (mediaType === 'image') {
                await sock.sendMessage(jid, { image: buffer, caption: '👀 *تم استخراج الصورة*' }, { quoted: msg });
            } else if (mediaType === 'video') {
                await sock.sendMessage(jid, { video: buffer, caption: '👀 *تم استخراج الفيديو*', mimetype: mediaMessage.mimetype || 'video/mp4' }, { quoted: msg });
            } else if (mediaType === 'audio') {
                await sock.sendMessage(jid, { audio: buffer, mimetype: mediaMessage.mimetype || 'audio/ogg; codecs=opus', ptt: mediaMessage.ptt || false }, { quoted: msg });
            } else if (mediaType === 'sticker') {
                await sock.sendMessage(jid, { sticker: buffer }, { quoted: msg });
            } else if (mediaType === 'document') {
                await sock.sendMessage(jid, { document: buffer, mimetype: mediaMessage.mimetype, fileName: mediaMessage.fileName || 'file' }, { quoted: msg });
            }

        } catch (error) {
            console.error('[عرض] Error:', error);
            await sock.sendMessage(jid, { text: '❌ حصل خطأ أثناء استخراج الوسائط.\n' + (error?.message || '') }, { quoted: msg });
        }
    }]
]);

// ═══════════════ 5. معالجة الرسائل (المسار السريع) ═══════════════
async function handleMessage(sock, msg) {
    const jid = msg?.key?.remoteJid;
    if (!msg?.message || !jid || jid === 'status@broadcast') return;
    
    if (sentStore.has(msg.key.id)) return;

    const text = getQuickText(msg);
    if (!text) return;

    const firstWord = text.split(' ')[0];
    if (!commands.has(firstWord)) return;

    console.log(`📥 أمر: [${firstWord}]`);
    
    try {
        await commands.get(firstWord)(sock, jid, msg);
    } catch (err) {
        console.error(`❌ خطأ في ${firstWord}:`, err.message);
    }
}

// ═══════════════ 6. التشغيل ═══════════════
async function getPhoneNumber() {
    return OWNER_NUMBER;
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
