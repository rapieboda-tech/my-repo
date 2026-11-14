'use strict';

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

const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const THUMB_PATH = path.join(__dirname, 'media', 'kaido.png');
const ALLOWED_CHATS = [];
const logger = pino({ level: 'silent' });

// ═══════════════ الذاكرة المؤقتة الذكية ═══════════════
const incomingStore = new Map();
// ═════════════════════════════════════════════════════

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

const groupBackup = new Map();
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
    let text = String(content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || content.videoMessage?.caption || '');
    text = text.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '');
    text = text.replace(/[إأآا]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
    text = text.replace(/^\.\s*/, '.');
    return text.trim();
}

async function checkAdmin(sock, jid, msg) {
    const groupMetadata = await getGroupMetadata(sock, jid);
    const participants = groupMetadata.participants || [];
    const botIds = [
        sock.user?.id, sock.user?.lid,
        sock.authState?.creds?.me?.id, sock.authState?.creds?.me?.lid
    ].filter(Boolean).map(id => id.split('@')[0].split(':')[0]);

    const senderIds = [msg.key.participant, msg.key.participantAlt].filter(Boolean).map(id => id.split('@')[0].split(':')[0]);
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

    const mentionedJid = contextInfo.mentionedJid || [];
    const quotedParticipant = contextInfo.participant;
    
    let targetJid = mentionedJid.length > 0 ? mentionedJid[0] : quotedParticipant;
    
    if (!targetJid) return null;
    
    const targetNum = targetJid.split('@')[0].split(':')[0];
    const targetParticipant = participants.find(p => {
        const pIds = [p.id, p.lid, p.phoneNumber].filter(Boolean).map(id => id.split('@')[0].split(':')[0]);
        return pIds.includes(targetNum);
    });
    
    if (targetParticipant) return targetParticipant;
    return { id: targetJid, admin: null };
}

async function addAdminCommand(sock, jid, msg) {
    if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ هذا الأمر يعمل في الجروبات فقط!' }, { quoted: msg });
    try {
        const { isBotAdmin, isSenderAdmin, participants } = await checkAdmin(sock, jid, msg);
        if (!isSenderAdmin) return await send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });
        if (!isBotAdmin) return await send(sock, jid, { text: '❌ يجب أن ترفعني مشرفاً أولاً!' }, { quoted: msg });

        const target = getTarget(msg, participants);
        if (!target) return await send(sock, jid, { text: '❌ لازم تعمل منشن أو ريبلاي على الشخص!' }, { quoted: msg });
        
        if (target.admin === 'admin' || target.admin === 'superadmin') return await send(sock, jid, { text: '⚠️ هذا الشخص مشرف بالفعل!' }, { quoted: msg });

        try {
            await sock.groupParticipantsUpdate(jid, [target.id], 'promote');
            const targetNum = target.id.split('@')[0];
            
            await send(sock, jid, { 
                text: `باااااامو يبن الملك باااامو يلاااااا 👑🔥 @${targetNum}`, 
                mentions: [target.id] 
            });
            groupMetaCache.delete(jid);
        } catch (promoteError) {
            console.error('❌ فشل الترقية:', promoteError.message);
            await send(sock, jid, { text: `❌ فشل واتساب في الترقية: ${promoteError.message}` }, { quoted: msg });
        }
        
    } catch (err) { 
        console.error('❌ خطأ في إضافة:', err.message); 
        await send(sock, jid, { text: '❌ حدث خطأ أثناء إضافة الإشراف.' }, { quoted: msg });
    }
}

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
                            renderLargerThumbnail: false, 
                            showAdAttribution: false 
                        } 
                    }
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
        const latency = (performance.now() - start).toFixed(2);
        await send(sock, jid, { text: `⚡ *سرعة الاستجابة:*\n> ${latency} ms` }, { quoted: msg });
    }],

    ['.الحاله', async (sock, jid, msg) => {
        const start = performance.now();
        try { await sock.fetchStatus(jid); } catch {}
        const ping = (performance.now() - start).toFixed(2);
        const uptimeSeconds = process.uptime();
        const hours = Math.floor(uptimeSeconds / 3600);
        const minutes = Math.floor((uptimeSeconds % 3600) / 60);
        const seconds = Math.floor(uptimeSeconds % 60);
        const uptimeStr = `${hours} ساعة و ${minutes} دقيقة و ${seconds} ثانية`;
        const usedMemory = process.memoryUsage().rss / 1024 / 1024;
        const totalMemory = os.totalmem() / 1024 / 1024;
        const platform = os.platform() === 'linux' ? 'Linux 🐧' : os.platform();
        await send(sock, jid, { text: `╭─━━━━━ 📊 ━━━━━─╮\n  *حًألَهً ألَسّيّسًتُّمِ*\n╰─━━━━━ 🩸 ━━━━━─╯\n⚡ *سرعة الاستجابة:* ${ping} ms\n⏱️ *مدة التشغيل:* ${uptimeStr}\n💾 *الذاكرة:* ${usedMemory.toFixed(2)} MB / ${totalMemory.toFixed(0)} MB\n💻 *النظام:* ${platform}\n⚙️ *Node.js:* ${process.version}` }, { quoted: msg });
    }],

    ['.فتح', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ هذا الأمر يعمل في الجروبات فقط!' }, { quoted: msg });
        try {
            const { isBotAdmin, isSenderAdmin, groupMetadata } = await checkAdmin(sock, jid, msg);
            if (!isSenderAdmin) return await send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });
            if (!isBotAdmin) return await send(sock, jid, { text: '❌ يجب أن ترفعني مشرفاً أولاً!' }, { quoted: msg });
            if (!groupMetadata.announce) return await send(sock, jid, { text: '⚠️ الجروب مفتوح بالفعل!' }, { quoted: msg });

            await sock.groupSettingUpdate(jid, 'not_announcement');
            await send(sock, jid, { text: '✅ *تم فتح الجروب بنجاح!* 🔓' });
            groupMetaCache.delete(jid);
        } catch (err) { console.error('❌ خطأ في فتح:', err.message); }
    }],

    ['.قفل', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ هذا الأمر يعمل في الجروبات فقط!' }, { quoted: msg });
        try {
            const { isBotAdmin, isSenderAdmin, groupMetadata } = await checkAdmin(sock, jid, msg);
            if (!isSenderAdmin) return await send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });
            if (!isBotAdmin) return await send(sock, jid, { text: '❌ يجب أن ترفعني مشرفاً أولاً!' }, { quoted: msg });
            if (groupMetadata.announce) return await send(sock, jid, { text: '⚠️ الجروب مقفول بالفعل!' }, { quoted: msg });

            await sock.groupSettingUpdate(jid, 'announcement');
            await send(sock, jid, { text: '✅ *تم قفل الجروب بنجاح!* 🔒' });
            groupMetaCache.delete(jid);
        } catch (err) { console.error('❌ خطأ في قفل:', err.message); }
    }],

    ['.سحب', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ هذا الأمر يعمل في الجروبات فقط!' }, { quoted: msg });
        try {
            const { isBotAdmin, isSenderAdmin, participants } = await checkAdmin(sock, jid, msg);
            if (!isSenderAdmin) return await send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });
            if (!isBotAdmin) return await send(sock, jid, { text: '❌ يجب أن ترفعني مشرفاً أولاً!' }, { quoted: msg });

            const target = getTarget(msg, participants);
            if (!target) return await send(sock, jid, { text: '❌ لازم تعمل منشن أو ريبلاي على الشخص!' }, { quoted: msg });
            
            if (target.admin === 'superadmin') return await send(sock, jid, { text: '❌ لا يمكنني سحب إشراف صاحب الجروب!' }, { quoted: msg });
            if (target.admin !== 'admin') return await send(sock, jid, { text: '⚠️ هذا الشخص ليس مشرفاً بالأساس!' }, { quoted: msg });

            await sock.groupParticipantsUpdate(jid, [target.id], 'demote');
            const targetNum = target.id.split('@')[0];
            
            await send(sock, jid, { 
                text: `ههههههه انطر 😂🥾 @${targetNum}`, 
                mentions: [target.id] 
            });
            groupMetaCache.delete(jid);
        } catch (err) { 
            console.error('❌ خطأ في سحب:', err.message); 
            await send(sock, jid, { text: '❌ حدث خطأ أثناء سحب الإشراف، تأكد من الصلاحيات.' }, { quoted: msg });
        }
    }],

    ['.اضافه', addAdminCommand],

    ['.زرف', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ هذا الأمر يعمل في الجروبات فقط!' }, { quoted: msg });
        try {
            const { isBotAdmin, isSenderAdmin, participants, botIds, senderIds, groupMetadata } = await checkAdmin(sock, jid, msg);
            if (!isSenderAdmin) return await send(sock, jid, { text: '❌ أنت لست مشرفاً لتستخدم هذا الأمر!' }, { quoted: msg });
            if (!isBotAdmin) return await send(sock, jid, { text: '❌ يجب أن ترفعني (البوت) مشرفاً أولاً!' }, { quoted: msg });

            let oldPicUrl = null;
            try { oldPicUrl = await sock.profilePictureUrl(jid, 'image'); } catch {}
            const oldAdmins = participants.filter(p => p.admin === 'admin').map(p => p.id);
            groupBackup.set(jid, { subject: groupMetadata.subject, description: groupMetadata.desc, picUrl: oldPicUrl, admins: oldAdmins, isLocked: groupMetadata.announce });

            const adminsToDemote = [];
            for (const p of participants) {
                if (p.admin === 'admin') {
                    const pIds = [p.id, p.lid, p.phoneNumber].filter(Boolean).map(id => id.split('@')[0].split(':')[0]);
                    const isBot = pIds.some(id => botIds.includes(id));
                    const isSender = pIds.some(id => senderIds.includes(id));
                    if (!isBot && !isSender) adminsToDemote.push(p.id);
                }
            }

            if (adminsToDemote.length > 0) await sock.groupParticipantsUpdate(jid, adminsToDemote, 'demote');
            if (getThumbnail()) await sock.updateProfilePicture(jid, { url: THUMB_PATH });
            await sock.groupUpdateDescription(jid, 'عمكم كايدو 🩸');
            await sock.groupUpdateSubject(jid, 'كايدو عمك 🩸');
            await sock.groupSettingUpdate(jid, 'announcement');
            groupMetaCache.delete(jid);

            await send(sock, jid, { text: `*كايدو عمك 🩸*` });
        } catch (err) { console.error('❌ خطأ في الزرف:', err.message); }
    }],

    ['.صفي', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ هذا الأمر يعمل في الجروبات فقط!' }, { quoted: msg });
        try {
            const { isBotAdmin, isSenderAdmin, participants, botIds, senderIds, groupMetadata } = await checkAdmin(sock, jid, msg);
            if (!isSenderAdmin) return await send(sock, jid, { text: '❌ أنت لست مشرفاً لتستخدم هذا الأمر!' }, { quoted: msg });
            if (!isBotAdmin) return await send(sock, jid, { text: '❌ يجب أن ترفعني (البوت) مشرفاً أولاً!' }, { quoted: msg });

            if (!groupBackup.has(jid)) {
                let oldPicUrl = null;
                try { oldPicUrl = await sock.profilePictureUrl(jid, 'image'); } catch {}
                groupBackup.set(jid, { subject: groupMetadata.subject, description: groupMetadata.desc, picUrl: oldPicUrl, admins: [], isLocked: groupMetadata.announce });
            }

            const membersToKick = [];
            for (const p of participants) {
                if (p.admin === 'superadmin') continue;
                const pIds = [p.id, p.lid, p.phoneNumber].filter(Boolean).map(id => id.split('@')[0].split(':')[0]);
                const isBot = pIds.some(id => botIds.includes(id));
                const isSender = pIds.some(id => senderIds.includes(id));
                if (!isBot && !isSender) membersToKick.push(p.id);
            }

            if (membersToKick.length > 0) {
                await sock.groupParticipantsUpdate(jid, membersToKick, 'remove');
                await send(sock, jid, { text: `✅ تم تصفية الجروب وطرد ${membersToKick.length} عضو! 🥾` });
            } else {
                await send(sock, jid, { text: `⚠️ مفيش حد يطرد!` });
            }
        } catch (err) { console.error('❌ خطأ في الصفي:', err.message); }
    }],

    ['.الغاء', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ هذا الأمر يعمل في الجروبات فقط!' }, { quoted: msg });
        try {
            const { isBotAdmin, isSenderAdmin } = await checkAdmin(sock, jid, msg);
            if (!isSenderAdmin) return await send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });
            if (!isBotAdmin) return await send(sock, jid, { text: '❌ يجب أن ترفعني مشرفاً أولاً!' }, { quoted: msg });

            const backup = groupBackup.get(jid);
            if (!backup) return await send(sock, jid, { text: '❌ مفيش عمليات سابقة عشان ألغيها!' }, { quoted: msg });

            if (backup.subject) await sock.groupUpdateSubject(jid, backup.subject).catch(()=>{});
            if (backup.description) await sock.groupUpdateDescription(jid, backup.description).catch(()=>{});
            if (backup.picUrl) await sock.updateProfilePicture(jid, { url: backup.picUrl }).catch(()=>{});
            if (backup.admins.length > 0) await sock.groupParticipantsUpdate(jid, backup.admins, 'promote').catch(()=>{});
            await sock.groupSettingUpdate(jid, backup.isLocked ? 'announcement' : 'not_announcement').catch(()=>{});

            groupBackup.delete(jid);
            groupMetaCache.delete(jid);
            await send(sock, jid, { text: `✅ *تم إلغاء الزرف وإرجاع كل حاجة زي ما كانت!*` });
        } catch (err) { console.error('❌ خطأ في الإلغاء:', err.message); }
    }],

    ['.فوقه', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ هذا الأمر يعمل في الجروبات فقط!' }, { quoted: msg });
        try {
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
        } catch (err) { console.error('❌ خطأ في فوقه:', err.message); }
    }],

    // ═══════════════ أمر المنشن (المخفي) ═══════════════
    ['منشن', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ هذا الأمر يعمل في الجروبات فقط!' }, { quoted: msg });
        try {
            const groupMetadata = await getGroupMetadata(sock, jid);
            const participants = groupMetadata.participants || [];
            const mentionJids = participants.map(p => p.id);
            
            await send(sock, jid, { 
                text: `> 𝑲𝒂𝒊𝒅𝒐`,
                mentions: mentionJids
            }, { quoted: msg });
            
        } catch (err) {
            console.error('❌ خطأ في منشن:', err.message);
        }
    }],
    // ═════════════════════════════════════════════════════════════════════════

    // ═══════════════ أمر العرض (باستخدام downloadMediaMessage) ═══════════════
    ['.عرض', async (sock, jid, msg) => {
        try {
            const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
            if (!contextInfo) return await send(sock, jid, { text: '❌ لازم تعمل ريبلاي على الرسالة!' }, { quoted: msg });

            const stanzaId = contextInfo.stanzaId;
            const originalMsg = incomingStore.get(stanzaId);
            
            if (!originalMsg) {
                return await send(sock, jid, { text: '❌ مش لاقي الرسالة الأصلية في الذاكرة. لازم البوت يكون شغال ساعة ما اتبعتت.' }, { quoted: msg });
            }

            let mediaType = null;
            let normalized = normalizeMessageContent(originalMsg.message);
            
            if (normalized?.imageMessage) mediaType = 'image';
            else if (normalized?.videoMessage) mediaType = 'video';
            else if (normalized?.audioMessage) mediaType = 'audio';

            if (!mediaType) return await send(sock, jid, { text: '❌ الرسالة دي مش عرض لمرة واحدة!' }, { quoted: msg });

            let buffer;
            try {
                // دي الدالة اللي بتفك التشفير وتنزل الميديا
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
    // ═════════════════════════════════════════════════════════════════════════
]);

async function handleMessage(sock, msg) {
    const jid = msg?.key?.remoteJid;
    if (!msg?.message || !jid || jid === 'status@broadcast') return;
    if (sentStore.has(msg.key.id)) return;

    // حفظ الرسالة في الذاكرة المؤقتة
    incomingStore.set(msg.key.id, msg);
    if (incomingStore.size > 50) incomingStore.delete(incomingStore.keys().next().value);

    const text = extractText(msg);
    const firstWord = text.split(/\s+/)[0]; 

    if (firstWord.startsWith('.') || firstWord === 'منشن') {
        console.log(`📥 أمر تم استقباله: [${firstWord}]`);
    }

    const command = commands.get(firstWord);
    if (!command) return;

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
