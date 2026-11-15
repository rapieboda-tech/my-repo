'use strict';

// ═══════════════════════════════════════
// 1. الحماية والاستيراد
// ═══════════════════════════════════════

process.on('uncaughtException', (err) => {
    console.error('⚠️ [Uncaught Exception]:', err);
    shutdown('uncaughtException');
});

process.on('unhandledRejection', (err) => {
    console.error('⚠️ [Unhandled Rejection]:', err);
});

const {
    default: makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    normalizeMessageContent,
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

// ═══════════════════════════════════════
// 2. الإعدادات
// ═══════════════════════════════════════

const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const THUMB_PATH = path.join(__dirname, 'media', 'kaido.png');

const OWNER_NUMBER = '201144953155';
const GROUP_META_TTL = 60 * 1000;

const logger = pino({ level: 'silent' });

const incomingStore = new Map();
const sentStore = new Map();
const groupBackup = new Map();
const groupMetaCache = new Map();

let thumbnail;
let currentSock = null;
let pairingPhone = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let shuttingDown = false;
let starting = false;
let waVersion = null;

global.botTurbo = false;

// ═══════════════════════════════════════
// 3. أدوات عامة
// ═══════════════════════════════════════

function trimMap(map, limit) {
    while (map.size > limit) {
        map.delete(map.keys().next().value);
    }
}

function getThumbnail() {
    if (thumbnail !== undefined) return thumbnail;

    try {
        if (fs.existsSync(THUMB_PATH)) {
            const buf = fs.readFileSync(THUMB_PATH);
            thumbnail = buf.length ? buf : null;
        } else {
            thumbnail = null;
        }
    } catch (err) {
        console.error('[Thumbnail]:', err.message);
        thumbnail = null;
    }

    return thumbnail;
}

const isLinked = (creds) => Boolean(creds?.registered);

function normalizePhone(raw) {
    const phone = String(raw || '').replace(/\D/g, '');
    return /^[1-9]\d{7,14}$/.test(phone) ? phone : null;
}

function ask(question) {
    return new Promise((resolve) => {
        if (!process.stdin.isTTY) return resolve(null);

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        rl.question(question, (answer) => {
            rl.close();
            resolve(String(answer || '').trim());
        });
    });
}

async function getPhoneNumber() {
    const preset = normalizePhone(
        process.env.PHONE_NUMBER ||
        process.argv[2] ||
        OWNER_NUMBER
    );

    if (preset) return preset;
    if (!process.stdin.isTTY) return null;

    for (let i = 0; i < 3; i++) {
        const answer = await ask('📱 أدخل رقم الواتساب بدون +: ');
        if (answer === null) return null;

        const phone = normalizePhone(answer);
        if (phone) return phone;
    }

    return null;
}

function extractText(msg) {
    const content = normalizeMessageContent(msg?.message);
    if (!content) return '';

    let text = String(
        content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.videoMessage?.caption ||
        ''
    );

    text = text.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '');
    text = text.replace(/[\u064B-\u0652]/g, ''); // إزالة التشكيل
    text = text.replace(/\u0640/g, ''); // إزالة التطويل (الكشيدة)
    text = text.replace(/[إأآا]/g, 'ا')
        .replace(/ة/g, 'ه')
        .replace(/ى/g, 'ي');

    return text.trim();
}

// دعم الأوامر التي تتكون من أكثر من كلمة
function findCommand(text) {
    const normalized = text.trim();

    // كلمة "تست" لازم تكون لوحدها بالظبط
    if (normalized === 'تست') return 'تست';

    const keys = [...commands.keys()]
        .sort((a, b) => b.length - a.length);

    return keys.find(key => {
        if (key === 'تست') return false; // تجاهل التطابق الجزئي لكلمة تست
        return normalized === key ||
               normalized.startsWith(key + ' ');
    }) || null;
}

function addIds(set, raw) {
    if (!raw) return;

    set.add(raw);

    const noAt = raw.split('@')[0];
    if (!noAt) return;

    set.add(noAt);

    const noDevice = noAt.split(':')[0];
    if (noDevice) set.add(noDevice);
}

function collectBotIds(sock) {
    const set = new Set();

    addIds(set, sock.user?.id);
    addIds(set, sock.user?.lid);
    addIds(set, sock.authState?.creds?.me?.id);
    addIds(set, sock.authState?.creds?.me?.lid);
    addIds(set, OWNER_NUMBER);

    return set;
}

function collectSenderIds(msg) {
    const set = new Set();

    addIds(set, msg.key?.participant);
    addIds(set, msg.key?.participantAlt);
    addIds(set, msg.key?.participantPn);
    addIds(set, msg.participant);
    addIds(set, msg.senderPn);

    return set;
}

function participantMatchesIdSet(p, idSet) {
    const fields = [
        p.id,
        p.lid,
        p.phoneNumber
    ].filter(Boolean);

    for (const field of fields) {
        const temp = new Set();
        addIds(temp, field);

        for (const id of temp) {
            if (idSet.has(id)) return true;
        }
    }

    return false;
}

// ═══════════════════════════════════════
// 4. بيانات الجروبات والصلاحيات
// ═══════════════════════════════════════

async function getGroupMetadata(sock, jid) {
    const cached = groupMetaCache.get(jid);

    if (cached && Date.now() - cached.ts < GROUP_META_TTL) {
        return cached.data;
    }

    const data = await sock.groupMetadata(jid);

    groupMetaCache.set(jid, {
        data,
        ts: Date.now()
    });

    return data;
}

async function checkAdmin(sock, jid, msg) {
    const groupMetadata = await getGroupMetadata(sock, jid);
    const participants = groupMetadata.participants || [];

    const botIds = collectBotIds(sock);
    const senderIds = collectSenderIds(msg);

    let isBotAdmin = false;
    let isSenderAdmin = false;

    for (const p of participants) {
        if (p.admin !== 'admin' && p.admin !== 'superadmin') continue;

        if (participantMatchesIdSet(p, botIds)) {
            isBotAdmin = true;
        }

        if (participantMatchesIdSet(p, senderIds)) {
            isSenderAdmin = true;
        }
    }

    return {
        isBotAdmin,
        isSenderAdmin,
        participants,
        botIds,
        senderIds,
        groupMetadata
    };
}

function getTarget(msg, participants) {
    const contextInfo =
        msg.message?.extendedTextMessage?.contextInfo ||
        msg.message?.imageMessage?.contextInfo ||
        msg.message?.videoMessage?.contextInfo;

    if (!contextInfo) return null;

    const targetJid =
        contextInfo.mentionedJid?.[0] ||
        contextInfo.participant;

    if (!targetJid) return null;

    const targetSet = new Set();
    addIds(targetSet, targetJid);

    return participants.find(p =>
        participantMatchesIdSet(p, targetSet)
    ) || null;
}

// ═══════════════════════════════════════
// 5. إرسال الرسائل والتخزين
// ═══════════════════════════════════════

async function send(sock, jid, content, options) {
    const sent = await sock.sendMessage(jid, content, options);

    if (sent?.key?.id && sent.message) {
        sentStore.set(sent.key.id, sent.message);
        trimMap(sentStore, 500);
    }

    return sent;
}

// ═══════════════════════════════════════
// 6. الأوامر
// ═══════════════════════════════════════

const commands = new Map([

    ['تست', async (sock, jid, msg) => {
        const content = {
            text: '> 𝑲𝒂𝒊𝒅𝒐 𝐁𝐨𝐭 𝐢𝐬 𝐨𝐧𝐥𝐢𝐧𝐞 🌹'
        };

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
                            renderLargerThumbnail: false,
                            showAdAttribution: false
                        }
                    }
                }, { quoted: msg });

                return;
            } catch (err) {
                console.error('[تست Thumbnail]:', err.message);
            }
        }

        await send(sock, jid, content, { quoted: msg });
    }],

    ['.تسريع الاستجابه', async (sock, jid, msg) => {
        global.botTurbo = true;
        groupMetaCache.clear();

        if (global.gc) {
            try {
                global.gc();
            } catch (err) {
                console.error('[GC]:', err.message);
            }
        }

        await send(sock, jid, {
            text: '🚀 *تم تفعيل وضع الصاروخ!*'
        }, { quoted: msg });
    }],

    ['.فحص', async (sock, jid, msg) => {
        const start = performance.now();

        try {
            await sock.fetchStatus(jid);
        } catch (err) {
            console.error('[Ping]:', err.message);
        }

        const ping = (performance.now() - start).toFixed(2);

        await send(sock, jid, {
            text: `⚡ *البينج:*\n> ${ping} ms`
        }, { quoted: msg });
    }],

    ['.الحاله', async (sock, jid, msg) => {
        const start = performance.now();

        try {
            await sock.fetchStatus(jid);
        } catch {}

        const ping = (performance.now() - start).toFixed(2);
        const uptime = process.uptime();

        const h = Math.floor(uptime / 3600);
        const m = Math.floor((uptime % 3600) / 60);
        const s = Math.floor(uptime % 60);

        const usedMem = (
            process.memoryUsage().rss / 1024 / 1024
        ).toFixed(2);

        const totalMem = (
            os.totalmem() / 1024 / 1024
        ).toFixed(0);

        await send(sock, jid, {
            text:
`╭─━━━━━ 📊 ━━━━━─╮
  *حًألَهً ألَسّيّسًتُّمِ*
╰─━━━━━ 🩸 ━━━━━─╯
⚡ *البينج:* ${ping} ms
⏱️ *التشغيل:* ${h}س ${m}د ${s}ث
💾 *الرامات:* ${usedMem} / ${totalMem} MB
🚀 *الصاروخ:* ${global.botTurbo ? 'مفعل 🔥' : 'معطل ❄️'}`
        }, { quoted: msg });
    }],

    ['.فتح', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) {
            return send(sock, jid, { text: '❌ للجروبات فقط!' }, { quoted: msg });
        }

        const { isBotAdmin, isSenderAdmin, groupMetadata } = await checkAdmin(sock, jid, msg);

        if (!isSenderAdmin) return send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });
        if (!isBotAdmin) return send(sock, jid, { text: '❌ يجب أن ترفعني مشرفاً أولاً!' }, { quoted: msg });
        if (!groupMetadata.announce) return send(sock, jid, { text: '⚠️ الجروب مفتوح بالفعل!' }, { quoted: msg });

        await sock.groupSettingUpdate(jid, 'not_announcement');
        groupMetaCache.delete(jid);

        await send(sock, jid, { text: '✅ *تم فتح الجروب!* 🔓' });
    }],

    ['.قفل', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) {
            return send(sock, jid, { text: '❌ للجروبات فقط!' }, { quoted: msg });
        }

        const { isBotAdmin, isSenderAdmin, groupMetadata } = await checkAdmin(sock, jid, msg);

        if (!isSenderAdmin) return send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });
        if (!isBotAdmin) return send(sock, jid, { text: '❌ يجب أن ترفعني مشرفاً أولاً!' }, { quoted: msg });
        if (groupMetadata.announce) return send(sock, jid, { text: '⚠️ الجروب مقفول بالفعل!' }, { quoted: msg });

        await sock.groupSettingUpdate(jid, 'announcement');
        groupMetaCache.delete(jid);

        await send(sock, jid, { text: '✅ *تم قفل الجروب!* 🔒' });
    }],

    ['.سحب', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) {
            return send(sock, jid, { text: '❌ للجروبات فقط!' }, { quoted: msg });
        }

        const { isBotAdmin, isSenderAdmin, participants } = await checkAdmin(sock, jid, msg);

        if (!isSenderAdmin) return send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });
        if (!isBotAdmin) return send(sock, jid, { text: '❌ يجب أن ترفعني مشرفاً أولاً!' }, { quoted: msg });

        const target = getTarget(msg, participants);

        if (!target) return send(sock, jid, { text: '❌ لازم تعمل منشن أو ريبلاي!' }, { quoted: msg });
        if (target.admin === 'superadmin') return send(sock, jid, { text: '❌ لا يمكنني سحب إشراف صاحب الجروب!' }, { quoted: msg });
        if (target.admin !== 'admin') return send(sock, jid, { text: '⚠️ هذا الشخص ليس مشرفاً!' }, { quoted: msg });

        await sock.groupParticipantsUpdate(jid, [target.id], 'demote');
        groupMetaCache.delete(jid);

        await send(sock, jid, {
            text: `ههههههه انطر 😂🥾 @${target.id.split('@')[0]}`,
            mentions: [target.id]
        });
    }],

    ['.اضافه', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) {
            return send(sock, jid, { text: '❌ للجروبات فقط!' }, { quoted: msg });
        }

        const { isBotAdmin, isSenderAdmin, participants } = await checkAdmin(sock, jid, msg);

        if (!isSenderAdmin) return send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });
        if (!isBotAdmin) return send(sock, jid, { text: '❌ يجب أن ترفعني مشرفاً أولاً!' }, { quoted: msg });

        const target = getTarget(msg, participants);

        if (!target) return send(sock, jid, { text: '❌ لازم تعمل منشن أو ريبلاي!' }, { quoted: msg });
        if (target.admin === 'admin' || target.admin === 'superadmin') return send(sock, jid, { text: '⚠️ هذا الشخص مشرف بالفعل!' }, { quoted: msg });

        await sock.groupParticipantsUpdate(jid, [target.id], 'promote');
        groupMetaCache.delete(jid);

        await send(sock, jid, {
            text: `باااااامو يبن الملك باااامو يلاااااا 👑🔥 @${target.id.split('@')[0]}`,
            mentions: [target.id]
        });
    }],

    ['.إضافه', async (sock, jid, msg) => {
        return commands.get('.اضافه')(sock, jid, msg);
    }],

    ['.زرف', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return send(sock, jid, { text: '❌ للجروبات فقط!' }, { quoted: msg });
        
        const { isBotAdmin, isSenderAdmin, participants, botIds, senderIds, groupMetadata } = await checkAdmin(sock, jid, msg);
        
        if (!isSenderAdmin) return send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });
        if (!isBotAdmin) return send(sock, jid, { text: '❌ يجب أن ترفعني مشرفاً أولاً!' }, { quoted: msg });

        let oldPicUrl = null;
        try { oldPicUrl = await sock.profilePictureUrl(jid, 'image'); } catch {}
        const oldAdmins = participants.filter(p => p.admin === 'admin').map(p => p.id);
        groupBackup.set(jid, {
            subject: groupMetadata.subject,
            description: groupMetadata.desc,
            picUrl: oldPicUrl,
            admins: oldAdmins,
            isLocked: groupMetadata.announce
        });

        const adminsToDemote = [];
        for (const p of participants) {
            if (p.admin === 'admin') {
                const isBot = participantMatchesIdSet(p, botIds);
                const isSender = participantMatchesIdSet(p, senderIds);
                if (!isBot && !isSender) {
                    adminsToDemote.push(p.id);
                }
            }
        }

        if (adminsToDemote.length > 0) {
            try { await sock.groupParticipantsUpdate(jid, adminsToDemote, 'demote'); } catch (e) { console.error('Demote:', e.message); }
        }

        const thumb = getThumbnail();
        if (thumb) {
            try { await sock.updateProfilePicture(jid, { url: THUMB_PATH }); } catch (e) { console.error('Pic:', e.message); }
        }
        try { await sock.groupUpdateDescription(jid, 'عمكم كايدو 🩸'); } catch (e) { console.error('Desc:', e.message); }
        try { await sock.groupUpdateSubject(jid, 'كايدو عمك 🩸'); } catch (e) { console.error('Subject:', e.message); }
        try { await sock.groupSettingUpdate(jid, 'announcement'); } catch (e) { console.error('Setting:', e.message); }
        
        groupMetaCache.delete(jid);

        const mentionJids = participants.map(p => p.id);
        await send(sock, jid, { text: `*كايدو عمك 🩸*`, mentions: mentionJids });
    }],

    ['.صفي', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return send(sock, jid, { text: '❌ للجروبات فقط!' }, { quoted: msg });
        
        const { isBotAdmin, isSenderAdmin, participants, botIds, senderIds } = await checkAdmin(sock, jid, msg);
        
        if (!isSenderAdmin) return send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });
        if (!isBotAdmin) return send(sock, jid, { text: '❌ يجب أن ترفعني مشرفاً أولاً!' }, { quoted: msg });

        const membersToKick = [];
        for (const p of participants) {
            if (p.admin === 'superadmin') continue;
            const isBot = participantMatchesIdSet(p, botIds);
            const isSender = participantMatchesIdSet(p, senderIds);
            if (!isBot && !isSender) {
                membersToKick.push(p.id);
            }
        }

        if (membersToKick.length > 0) {
            await sock.groupParticipantsUpdate(jid, membersToKick, 'remove');
            await send(sock, jid, { text: `✅ تم تصفية الجروب وطرد ${membersToKick.length} عضو! 🥾` });
        } else {
            await send(sock, jid, { text: `⚠️ مفيش حد يطرد!` });
        }
    }],

    ['.الغاء', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return send(sock, jid, { text: '❌ للجروبات فقط!' }, { quoted: msg });
        
        const { isBotAdmin, isSenderAdmin } = await checkAdmin(sock, jid, msg);
        
        if (!isSenderAdmin) return send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });
        if (!isBotAdmin) return send(sock, jid, { text: '❌ يجب أن ترفعني مشرفاً أولاً!' }, { quoted: msg });

        const backup = groupBackup.get(jid);
        if (!backup) return send(sock, jid, { text: '❌ مفيش عمليات سابقة عشان ألغيها!' }, { quoted: msg });

        let restored = 0, failed = 0;

        if (backup.subject) {
            try { await sock.groupUpdateSubject(jid, backup.subject); restored++; await new Promise(r => setTimeout(r, 500)); } catch (e) { console.error('Subject:', e.message); failed++; }
        }

        if (backup.description) {
            try { await sock.groupUpdateDescription(jid, backup.description); restored++; await new Promise(r => setTimeout(r, 500)); } catch (e) { console.error('Desc:', e.message); failed++; }
        }

        if (backup.picUrl) {
            try { await sock.updateProfilePicture(jid, { url: backup.picUrl }); restored++; await new Promise(r => setTimeout(r, 500)); } catch (e) { console.error('Pic:', e.message); failed++; }
        }

        if (backup.admins && backup.admins.length > 0) {
            let freshMeta;
            try { freshMeta = await sock.groupMetadata(jid); } catch (e) { freshMeta = { participants: [] }; }
            const freshParticipants = freshMeta.participants || [];
            
            const adminsToPromote = [];
            for (const savedId of backup.admins) {
                const savedSet = new Set();
                addIds(savedSet, savedId);
                const currentP = freshParticipants.find(p => participantMatchesIdSet(p, savedSet));
                if (currentP && currentP.admin !== 'admin' && currentP.admin !== 'superadmin') {
                    adminsToPromote.push(currentP.id);
                }
            }
            
            if (adminsToPromote.length > 0) {
                try { await sock.groupParticipantsUpdate(jid, adminsToPromote, 'promote'); restored += adminsToPromote.length; await new Promise(r => setTimeout(r, 500)); } catch (e) { console.error('Admins:', e.message); failed++; }
            }
        }

        try { await sock.groupSettingUpdate(jid, backup.isLocked ? 'announcement' : 'not_announcement'); await new Promise(r => setTimeout(r, 300)); } catch (e) { console.error('Setting:', e.message); }

        groupBackup.delete(jid);
        groupMetaCache.delete(jid);

        if (failed === 0) {
            await send(sock, jid, { text: `✅ *تم إرجاع كل حاجة زي ما كانت!*\nعمليات ناجحة: ${restored}` });
        } else {
            await send(sock, jid, { text: `⚠️ تم استرجاع ${restored} عملية، فشل ${failed}.` });
        }
    }],

    ['.فوقه', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) {
            return send(sock, jid, { text: '❌ للجروبات فقط!' }, { quoted: msg });
        }

        const groupMetadata = await getGroupMetadata(sock, jid);
        const participants = groupMetadata.participants || [];

        let adminsList = '';
        let membersList = '';
        const mentionJids = [];

        for (const p of participants) {
            const userNum = p.id.split('@')[0];
            const mentionText = `@${userNum}\n`;

            if (p.admin === 'admin' || p.admin === 'superadmin') {
                adminsList += `${p.admin === 'superadmin' ? '👑' : '🛡️'} ${mentionText}`;
            } else {
                membersList += `👤 ${mentionText}`;
            }

            mentionJids.push(p.id);
        }

        await send(sock, jid, {
            text:
`╭─━━━━━ 👑 ━━━━━─╮
*المشرفين:*
${adminsList || 'لا يوجد'}

╭─━━━━━ 👤 ━━━━━─╮
*الأعضاء:*
${membersList || 'لا يوجد'}
╰─━━━━━ 🩸 ━━━━━─╯`,
            mentions: mentionJids
        }, { quoted: msg });
    }],

    ['منشن', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) {
            return send(sock, jid, { text: '❌ للجروبات فقط!' }, { quoted: msg });
        }

        const groupMetadata = await getGroupMetadata(sock, jid);

        await send(sock, jid, {
            text: '> 𝑲𝒂𝒊𝒅𝒐',
            mentions: groupMetadata.participants.map(p => p.id)
        });
    }],

    ['.كشف', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) {
            return send(sock, jid, { text: '❌ هذا الأمر يعمل في الجروبات فقط!' }, { quoted: msg });
        }

        const { isSenderAdmin, participants, botIds } = await checkAdmin(sock, jid, msg);

        if (!isSenderAdmin) {
            return send(sock, jid, { text: '❌ أنت لست مشرفاً لتستخدم هذا الأمر!' }, { quoted: msg });
        }

        const targets = participants.filter(p =>
            !participantMatchesIdSet(p, botIds)
        );

        if (!targets.length) {
            return send(sock, jid, { text: '✅ لا يوجد أعضاء لفحصهم.' }, { quoted: msg });
        }

        const statusMsg = await send(sock, jid, { text: '🔎 جاري فحص أعضاء الجروب والأجهزة المرتبطة...' }, { quoted: msg });

        const results = [];

        for (let i = 0; i < targets.length; i++) {
            const p = targets[i];

            if (i > 0 && i % 3 === 0) {
                try {
                    await send(sock, jid, { text: `🔎 جاري الفحص... (${i}/${targets.length})`, edit: statusMsg.key });
                } catch (err) {
                    console.error('[كشف Progress]:', err.message);
                }
            }

            try {
                let targetJid = p.id;
                if (targetJid.endsWith('@lid') && p.phoneNumber) {
                    targetJid = p.phoneNumber.split('@')[0] + '@s.whatsapp.net';
                }

                const query = new USyncQuery()
                    .withDeviceProtocol()
                    .withUser(new USyncUser().withId(targetJid));

                const result = await sock.executeUSyncQuery(query);
                const devices = result?.list?.[0]?.devices || [];

                const label = devices.length > 1 ? '🤖 أجهزة متعددة' : devices.length === 1 ? '📱 جهاز واحد' : '❌ غير مسجل';

                results.push(`@${p.id.split('@')[0].split(':')[0]} : ${devices.length} جهاز (${label})`);

            } catch (err) {
                console.error('[كشف Member]:', err.message);
                results.push(`@${p.id.split('@')[0].split(':')[0]} : ⚠️ غير معروف`);
            }

            await new Promise(resolve => setTimeout(resolve, 400));
        }

        const finalText =
`╭─━━━━━ 🔎 ━━━━━─╮
*تقرير الكشف*
╰─━━━━━ 🩸 ━━━━━─╯

${results.join('\n')}

> *قد لا تتوفر معلومات الأجهزة لجميع الأعضاء.*`;

        await send(sock, jid, {
            text: finalText,
            mentions: targets.map(p => p.id),
            edit: statusMsg.key
        });
    }],

    ['.عرض', async (sock, jid, msg) => {
        try {
            const contextInfo = msg?.message?.extendedTextMessage?.contextInfo;

            if (!contextInfo) {
                return send(sock, jid, { text: '❌ لازم تعمل ريبلاي على الرسالة!' }, { quoted: msg });
            }

            const cachedMsg = incomingStore.get(contextInfo.stanzaId);
            let quoted = cachedMsg ? cachedMsg.message : contextInfo?.quotedMessage;

            if (!quoted) {
                return send(sock, jid, { text: '❌ مش قادر ألاقي الرسالة الأصلية.' }, { quoted: msg });
            }

            let viewOnceMsg = quoted;
            if (quoted.viewOnceMessage?.message) viewOnceMsg = quoted.viewOnceMessage.message;
            else if (quoted.viewOnceMessageV2?.message) viewOnceMsg = quoted.viewOnceMessageV2.message;
            else if (quoted.viewOnceMessageV2Extension?.message) viewOnceMsg = quoted.viewOnceMessageV2Extension.message;

            let mediaType = null, mediaMessage = null;
            if (viewOnceMsg.imageMessage) { mediaType = 'image'; mediaMessage = viewOnceMsg.imageMessage; }
            else if (viewOnceMsg.videoMessage) { mediaType = 'video'; mediaMessage = viewOnceMsg.videoMessage; }
            else if (viewOnceMsg.audioMessage) { mediaType = 'audio'; mediaMessage = viewOnceMsg.audioMessage; }

            if (!mediaType || !mediaMessage) {
                return send(sock, jid, { text: '❌ الرسالة دي مش عرض لمرة واحدة!' }, { quoted: msg });
            }

            let buffer = Buffer.from([]);
            try {
                buffer = await downloadMediaMessage(
                    cachedMsg || { key: { remoteJid: jid, id: contextInfo.stanzaId, participant: contextInfo.participant }, message: quoted },
                    'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }
                );
            } catch (e) {
                return send(sock, jid, { text: `❌ فشل التحميل: ${e.message}` }, { quoted: msg });
            }

            if (!buffer || buffer.length < 100) {
                return send(sock, jid, { text: '❌ الوسائط فاضية أو مش مكتملة.' }, { quoted: msg });
            }

            if (mediaType === 'image') await send(sock, jid, { image: buffer, caption: '👀 *تم استخراج الصورة*' }, { quoted: msg });
            else if (mediaType === 'video') await send(sock, jid, { video: buffer, caption: '👀 *تم استخراج الفيديو*', mimetype: mediaMessage.mimetype || 'video/mp4' }, { quoted: msg });
            else if (mediaType === 'audio') await send(sock, jid, { audio: buffer, mimetype: mediaMessage.mimetype || 'audio/ogg; codecs=opus', ptt: mediaMessage.ptt || false }, { quoted: msg });

        } catch (error) {
            console.error('[عرض]:', error);
            await send(sock, jid, { text: '❌ حدث خطأ أثناء معالجة الوسائط.\n' + (error?.message || 'خطأ غير معروف') }, { quoted: msg });
        }
    }]
]);

// ═══════════════════════════════════════
// 7. معالجة الرسائل
// ═══════════════════════════════════════

async function handleMessage(sock, msg) {
    const jid = msg?.key?.remoteJid;

    if (!msg?.message || !jid || jid === 'status@broadcast') return;
    if (sentStore.has(msg.key.id)) return;

    const m = msg.message;
    if (m?.viewOnceMessage || m?.viewOnceMessageV2 || m?.viewOnceMessageV2Extension) {
        incomingStore.set(msg.key.id, msg);
        trimMap(incomingStore, 50);
    }

    const text = extractText(msg);
    if (!text) return;

    const command = findCommand(text);
    if (!command) return;

    console.log(`📥 أمر: [${command}]`);

    try {
        await commands.get(command)(sock, jid, msg);
    } catch (err) {
        console.error(`❌ خطأ في ${command}:`, err);
        try {
            await send(sock, jid, { text: `❌ حدث خطأ في الأمر ${command}.\n${err.message || ''}` }, { quoted: msg });
        } catch (sendError) {
            console.error('[Error Reply]:', sendError.message);
        }
    }
}

// ═══════════════════════════════════════
// 8. إعادة الاتصال
// ═══════════════════════════════════════

function scheduleRestart(delay) {
    if (shuttingDown) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
        safeStart();
    }, delay);
}

async function safeStart() {
    if (shuttingDown || starting) return;
    starting = true;
    try {
        await startBot();
    } catch (err) {
        console.error('[Start Error]:', err);
        reconnectAttempts++;
        const delay = Math.min(2000 * reconnectAttempts, 30000);
        scheduleRestart(delay);
    } finally {
        starting = false;
    }
}

// ═══════════════════════════════════════
// 9. تشغيل واتساب
// ═══════════════════════════════════════

async function startBot() {
    let { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    if (!isLinked(state.creds)) {
        pairingPhone = pairingPhone || await getPhoneNumber();
        if (!pairingPhone) throw new Error('لم يتم تحديد رقم الهاتف للربط.');
    }

    if (!waVersion) {
        try {
            const result = await fetchLatestBaileysVersion();
            if (result?.version) {
                waVersion = result.version;
                console.log('📦 WhatsApp Version:', waVersion.join('.'));
            }
        } catch (err) {
            console.error('[Version]:', err.message);
        }
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

        getMessage: async (key) => {
            if (incomingStore.has(key.id)) {
                return incomingStore.get(key.id).message;
            }
            return sentStore.get(key.id) || { conversation: '' };
        },

        cachedGroupMetadata: async (jid) => {
            return groupMetaCache.get(jid)?.data;
        }
    });

    currentSock = sock;
    let codeRequested = false;
    let messageQueue = Promise.resolve();

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && pairingPhone && !codeRequested && !isLinked(state.creds)) {
            codeRequested = true;
            try {
                const code = await sock.requestPairingCode(pairingPhone);
                console.log('\n🔑 كود الربط: ' + (code.match(/.{1,4}/g) || [code]).join('-') + '\n');
            } catch (err) {
                console.error('[Pairing]:', err.message);
                codeRequested = false;
            }
        }

        if (connection === 'open') {
            reconnectAttempts = 0;
            pairingPhone = null;
            console.log('\n✅ تم الاتصال بنجاح!');
            try {
                await sock.updateProfileName('𝑲𝒂𝒊𝒅𝒐');
            } catch (err) {
                console.error('[Profile Name]:', err.message);
            }
            return;
        }

        if (connection !== 'close') return;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.error('⚠️ الاتصال أغلق. Status:', statusCode);

        try {
            sock.ev.removeAllListeners('connection.update');
            sock.ev.removeAllListeners('messages.upsert');
        } catch (err) {
            console.error('[Listeners]:', err.message);
        }

        if (currentSock === sock) currentSock = null;
        if (shuttingDown) return;

        if (statusCode === DisconnectReason.loggedOut) {
            console.error('❌ الحساب خرج من الجلسة. أعد الربط يدوياً.');
            process.exitCode = 1;
            shutdown('loggedOut');
            return;
        }

        if (statusCode === DisconnectReason.connectionReplaced) {
            console.error('⚠️ تم استبدال اتصال البوت.');
            shutdown('connectionReplaced');
            return;
        }

        if (statusCode === DisconnectReason.restartRequired) {
            scheduleRestart(1000);
            return;
        }

        reconnectAttempts++;
        const delay = Math.min(2000 * reconnectAttempts, 30000);
        console.log(`🔄 إعادة الاتصال بعد ${delay} ms`);
        scheduleRestart(delay);
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;

        messageQueue = messageQueue.then(async () => {
            for (const msg of messages) {
                try {
                    await handleMessage(sock, msg);
                } catch (err) {
                    console.error('[Message Handler]:', err);
                }
            }
        }).catch(err => {
            console.error('[Message Queue]:', err);
        });
    });
}

// ═══════════════════════════════════════
// 10. إيقاف البوت
// ═══════════════════════════════════════

function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n🛑 إيقاف البوت: ${signal}`);
    clearTimeout(reconnectTimer);
    try {
        currentSock?.end(undefined);
    } catch (err) {
        console.error('[Shutdown]:', err.message);
    }
    setTimeout(() => {
        process.exit(process.exitCode || 0);
    }, 500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ═══════════════════════════════════════
// 11. البداية
// ═══════════════════════════════════════

console.log('🐉 Kaido Bot Starting...');

safeStart();
