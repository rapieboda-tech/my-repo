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

// ═══════════════ 2. الإعدادات ═══════════════
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const THUMB_PATH = path.join(__dirname, 'media', 'kaido.png');
const OWNER_NUMBER = '201144953155';
const logger = pino({ level: 'silent' });

const incomingStore = new Map();
const sentStore = new Map();
const groupBackup = new Map();
const groupMetaCache = new Map();
const GROUP_META_TTL = 60 * 1000;

let thumbnail = undefined;
let currentSock = null;
let pairingPhone = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let shuttingDown = false;
let starting = false;
let waVersion = null;
global.botTurbo = false;

// ═══════════════ 3. مساعدات ═══════════════
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

function collectBotIds(sock) {
    const set = new Set();
    const add = (raw) => {
        if (!raw) return;
        set.add(raw);
        const noAt = raw.split('@')[0];
        if (noAt) {
            set.add(noAt);
            const noDev = noAt.split(':')[0];
            if (noDev) set.add(noDev);
        }
    };
    add(sock.user?.id);
    add(sock.user?.lid);
    add(sock.authState?.creds?.me?.id);
    add(sock.authState?.creds?.me?.lid);
    add(OWNER_NUMBER);
    return set;
}

function collectSenderIds(msg) {
    const set = new Set();
    const add = (raw) => {
        if (!raw) return;
        set.add(raw);
        const noAt = raw.split('@')[0];
        if (noAt) {
            set.add(noAt);
            const noDev = noAt.split(':')[0];
            if (noDev) set.add(noDev);
        }
    };
    add(msg.key?.participant);
    add(msg.key?.participantAlt);
    add(msg.key?.participantPn);
    add(msg.participant);
    add(msg.senderPn);
    return set;
}

function participantMatchesIdSet(p, idSet) {
    const fields = [p.id, p.lid, p.phoneNumber].filter(Boolean);
    for (const f of fields) {
        if (idSet.has(f)) return true;
        const noAt = f.split('@')[0];
        if (noAt && idSet.has(noAt)) return true;
        const noDev = noAt?.split(':')[0];
        if (noDev && idSet.has(noDev)) return true;
    }
    return false;
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
    const preset = normalizePhone(process.env.PHONE_NUMBER || process.argv[2] || OWNER_NUMBER);
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
    const botIds = collectBotIds(sock);
    const senderIds = collectSenderIds(msg);

    let isBotAdmin = false, isSenderAdmin = false;
    for (const p of participants) {
        if (p.admin === 'admin' || p.admin === 'superadmin') {
            if (participantMatchesIdSet(p, botIds)) isBotAdmin = true;
            if (participantMatchesIdSet(p, senderIds)) isSenderAdmin = true;
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
        if (!isSenderAdmin) return await send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });
        if (!isBotAdmin) return await send(sock, jid, { text: '❌ يجب أن ترفعني مشرفاً أولاً!' }, { quoted: msg });
        if (!groupMetadata.announce) return await send(sock, jid, { text: '⚠️ الجروب مفتوح بالفعل!' }, { quoted: msg });
        await sock.groupSettingUpdate(jid, 'not_announcement');
        groupMetaCache.delete(jid);
        await send(sock, jid, { text: '✅ *تم فتح الجروب!* 🔓' });
    }],

    ['.قفل', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ للجروبات فقط!' }, { quoted: msg });
        const { isBotAdmin, isSenderAdmin, groupMetadata } = await checkAdmin(sock, jid, msg);
        if (!isSenderAdmin) return await send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });
        if (!isBotAdmin) return await send(sock, jid, { text: '❌ يجب أن ترفعني مشرفاً أولاً!' }, { quoted: msg });
        if (groupMetadata.announce) return await send(sock, jid, { text: '⚠️ الجروب مقفول بالفعل!' }, { quoted: msg });
        await sock.groupSettingUpdate(jid, 'announcement');
        groupMetaCache.delete(jid);
        await send(sock, jid, { text: '✅ *تم قفل الجروب!* 🔒' });
    }],

    ['.سحب', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ للجروبات فقط!' }, { quoted: msg });
        const { isBotAdmin, isSenderAdmin, participants } = await checkAdmin(sock, jid, msg);
        if (!isSenderAdmin) return await send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });
        if (!isBotAdmin) return await send(sock, jid, { text: '❌ يجب أن ترفعني مشرفاً أولاً!' }, { quoted: msg });
        const target = getTarget(msg, participants);
        if (!target) return await send(sock, jid, { text: '❌ لازم تعمل منشن أو ريبلاي!' }, { quoted: msg });
        if (target.admin === 'superadmin') return await send(sock, jid, { text: '❌ لا يمكنني سحب إشراف صاحب الجروب!' }, { quoted: msg });
        if (target.admin !== 'admin') return await send(sock, jid, { text: '⚠️ هذا الشخص ليس مشرفاً!' }, { quoted: msg });
        await sock.groupParticipantsUpdate(jid, [target.id], 'demote');
        groupMetaCache.delete(jid);
        await send(sock, jid, { text: `ههههههه انطر 😂🥾 @${target.id.split('@')[0]}`, mentions: [target.id] });
    }],

    ['.اضافه', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ للجروبات فقط!' }, { quoted: msg });
        const { isBotAdmin, isSenderAdmin, participants } = await checkAdmin(sock, jid, msg);
        if (!isSenderAdmin) return await send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });
        if (!isBotAdmin) return await send(sock, jid, { text: '❌ يجب أن ترفعني مشرفاً أولاً!' }, { quoted: msg });
        const target = getTarget(msg, participants);
        if (!target) return await send(sock, jid, { text: '❌ لازم تعمل منشن أو ريبلاي!' }, { quoted: msg });
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
        try {
            const { isBotAdmin, isSenderAdmin, participants, groupMetadata } = await checkAdmin(sock, jid, msg);
            if (!isSenderAdmin) return await send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });
            if (!isBotAdmin) return await send(sock, jid, { text: '❌ يجب أن ترفعني مشرفاً أولاً!' }, { quoted: msg });

            const botIds = collectBotIds(sock);
            const senderIds = collectSenderIds(msg);
            
            const botParticipant = participants.find(p => 
                (p.admin === 'admin' || p.admin === 'superadmin') && participantMatchesIdSet(p, botIds)
            );
            
            if (!botParticipant) {
                console.error('❌ فشل التعرف على البوت. IDs:', Array.from(botIds));
                return await send(sock, jid, { text: '❌ لم أتمكن من تحديد هويتي. تم إلغاء العملية للحماية.' }, { quoted: msg });
            }
            
            const senderParticipant = participants.find(p => participantMatchesIdSet(p, senderIds));

            let oldPicUrl = null;
            try { oldPicUrl = await sock.profilePictureUrl(jid, 'image'); } catch {}
            const oldAdmins = participants.filter(p => p.admin === 'admin').map(p => p.id);
            groupBackup.set(jid, { subject: groupMetadata.subject, description: groupMetadata.desc, picUrl: oldPicUrl, admins: oldAdmins, isLocked: groupMetadata.announce });

            const adminsToDemote = [];
            for (const p of participants) {
                if (p.admin !== 'admin') continue;
                if (p.id === botParticipant.id) continue;
                if (senderParticipant && p.id === senderParticipant.id) continue;
                if (participantMatchesIdSet(p, botIds)) continue;
                if (participantMatchesIdSet(p, senderIds)) continue;
                adminsToDemote.push(p.id);
            }

            if (adminsToDemote.length > 0) {
                try { await sock.groupParticipantsUpdate(jid, adminsToDemote, 'demote'); } catch (e) { console.error('Demote:', e.message); }
            }
            
            try { if (getThumbnail()) await sock.updateProfilePicture(jid, { url: THUMB_PATH }); } catch(e) { console.error('Pic:', e.message); }
            try { await sock.groupUpdateDescription(jid, 'عمكم كايدو 🩸'); } catch(e) { console.error('Desc:', e.message); }
            try { await sock.groupUpdateSubject(jid, 'كايدو عمك 🩸'); } catch(e) { console.error('Subject:', e.message); }
            try { await sock.groupSettingUpdate(jid, 'announcement'); } catch(e) { console.error('Setting:', e.message); }
            
            groupMetaCache.delete(jid);

            const mentionJids = participants.map(p => p.id);
            await send(sock, jid, { text: `*كايدو عمك 🩸*`, mentions: mentionJids });
            
        } catch (err) { 
            console.error('❌ خطأ في الزرف:', err.message); 
            await send(sock, jid, { text: `❌ حدث خطأ: ${err.message}` }, { quoted: msg });
        }
    }],

    ['.صفي', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ للجروبات فقط!' }, { quoted: msg });
        const { isBotAdmin, isSenderAdmin, participants } = await checkAdmin(sock, jid, msg);
        if (!isSenderAdmin) return await send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });
        if (!isBotAdmin) return await send(sock, jid, { text: '❌ يجب أن ترفعني مشرفاً أولاً!' }, { quoted: msg });
        
        const botIds = collectBotIds(sock);
        const senderIds = collectSenderIds(msg);
        
        const membersToKick = participants.filter(p => {
            if (p.admin === 'superadmin') return false;
            if (participantMatchesIdSet(p, botIds)) return false;
            if (participantMatchesIdSet(p, senderIds)) return false;
            return true;
        }).map(p => p.id);
        
        if (membersToKick.length > 0) {
            await sock.groupParticipantsUpdate(jid, membersToKick, 'remove');
            await send(sock, jid, { text: `✅ تم تصفية الجروب وطرد ${membersToKick.length} عضو! 🥾` });
        } else {
            await send(sock, jid, { text: `⚠️ مفيش حد يطرد!` });
        }
    }],

    ['.الغاء', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ هذا الأمر يعمل في الجروبات فقط!' }, { quoted: msg });
        try {
            const { isBotAdmin, isSenderAdmin } = await checkAdmin(sock, jid, msg);
            if (!isSenderAdmin) return await send(sock, jid, { text: '❌ أنت لست مشرفاً!' }, { quoted: msg });
            if (!isBotAdmin) return await send(sock, jid, { text: '❌ يجب أن ترفعني مشرفاً أولاً!' }, { quoted: msg });

            const backup = groupBackup.get(jid);
            if (!backup) return await send(sock, jid, { text: '❌ مفيش عمليات سابقة عشان ألغيها!' }, { quoted: msg });

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
                    const add = (raw) => {
                        if (!raw) return;
                        savedSet.add(raw);
                        const noAt = raw.split('@')[0];
                        if (noAt) {
                            savedSet.add(noAt);
                            const noDev = noAt.split(':')[0];
                            if (noDev) savedSet.add(noDev);
                        }
                    };
                    add(savedId);
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
                await send(sock, jid, { text: `⚠️ تم استرجاع ${restored} عملية، فشل ${failed}.\nراجع اللوجز.` });
            }
        } catch (err) { 
            console.error('❌ خطأ في الإلغاء:', err.message); 
            await send(sock, jid, { text: `❌ حدث خطأ: ${err.message}` }, { quoted: msg });
        }
    }],

    ['.فوقه', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ للجروبات فقط!' }, { quoted: msg });
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
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ للجروبات فقط!' }, { quoted: msg });
        const groupMetadata = await getGroupMetadata(sock, jid);
        await send(sock, jid, { text: `> 𝑲𝒂𝒊𝒅𝒐`, mentions: groupMetadata.participants.map(p => p.id) });
    }],

    ['.كشف', async (sock, jid, msg) => {
        if (!jid.endsWith('@g.us')) return await send(sock, jid, { text: '❌ هذا الأمر يعمل في الجروبات فقط!' }, { quoted: msg });
        const { isSenderAdmin, participants, botIds } = await checkAdmin(sock, jid, msg);
        if (!isSenderAdmin) return await send(sock, jid, { text: '❌ أنت لست مشرفاً لتستخدم هذا الأمر!' }, { quoted: msg });

        const statusMsg = await send(sock, jid, { text: '🔎 جاري فحص أعضاء الجروب والأجهزة المرتبطة...' }, { quoted: msg });
        const targets = participants.filter(p => {
            const pIds = [p.id, p.lid, p.phoneNumber].filter(Boolean).map(id => id.split('@')[0].split(':')[0]);
            return !pIds.some(id => botIds.includes(id));
        });

        if (targets.length === 0) return await send(sock, jid, { text: '✅ لا يوجد أعضاء لفحصهم.', edit: statusMsg.key });

        const results = [];
        for (let i = 0; i < targets.length; i++) {
            const p = targets[i];
            if (i > 0 && i % 3 === 0) {
                try { await send(sock, jid, { text: `🔎 جاري الفحص... (${i}/${targets.length})`, edit: statusMsg.key }); } catch(e){}
            }
            try {
                let targetJid = p.id;
                if (targetJid.endsWith('@lid') && p.phoneNumber) {
                    targetJid = p.phoneNumber.split('@')[0] + '@s.whatsapp.net';
                }
                const query = new USyncQuery().withDeviceProtocol().withUser(new USyncUser().withId(targetJid));
                const result = await sock.executeUSyncQuery(query);
                const devices = result?.list?.[0]?.devices || [];
                let label = devices.length > 1 ? ' 🤖 (أجهزة متعددة)' : devices.length === 1 ? ' 📱 (جهاز واحد)' : ' ❌ (غير مسجل)';
                results.push(`@${p.id.split('@')[0].split(':')[0]} : ${devices.length} جهاز${label}`);
            } catch (e) {
                results.push(`@${p.id.split('@')[0].split(':')[0]} : ⚠️ غير معروف`);
            }
            await new Promise(r => setTimeout(r, 400));
        }

        const finalText = `╭─━━━━━ 🔎 ━━━━━─╮\n*تقرير الكشف الشامل*\n╰─━━━━━ 🩸 ━━━━━─╯\n\n` + results.join('\n') + `\n\n> *عدد الأجهزة يشمل الهاتف والأجهزة المرتبطة.*`;
        await send(sock, jid, { text: finalText, mentions: targets.map(p => p.id), edit: statusMsg.key });
    }],

    ['.عرض', async (sock, jid, msg) => {
        try {
            const contextInfo = msg?.message?.extendedTextMessage?.contextInfo;
            if (!contextInfo) return await send(sock, jid, { text: '❌ لازم تعمل ريبلاي على الرسالة!' }, { quoted: msg });

            let quoted = contextInfo?.quotedMessage;
            if (!quoted) {
                const cached = incomingStore.get(contextInfo.stanzaId);
                if (cached) quoted = cached.message;
            }

            if (!quoted) {
                return await send(sock, jid, { text: '❌ مش قادر ألاقي الرسالة الأصلية.' }, { quoted: msg });
            }

            let viewOnceMsg = quoted;
            if (quoted.viewOnceMessage?.message) viewOnceMsg = quoted.viewOnceMessage.message;
            else if (quoted.viewOnceMessageV2?.message) viewOnceMsg = quoted.viewOnceMessageV2.message;
            else if (quoted.viewOnceMessageV2Extension?.message) viewOnceMsg = quoted.viewOnceMessageV2Extension.message;

            let mediaType = null, mediaMessage = null;
            if (viewOnceMsg.imageMessage) { mediaType = 'image'; mediaMessage = viewOnceMsg.imageMessage; }
            else if (viewOnceMsg.videoMessage) { mediaType = 'video'; mediaMessage = viewOnceMsg.videoMessage; }
            else if (viewOnceMsg.audioMessage) { mediaType = 'audio'; mediaMessage = viewOnceMsg.audioMessage; }
            else if (viewOnceMsg.documentMessage) { mediaType = 'document'; mediaMessage = viewOnceMsg.documentMessage; }
            else if (viewOnceMsg.stickerMessage) { mediaType = 'sticker'; mediaMessage = viewOnceMsg.stickerMessage; }

            if (!mediaType || !mediaMessage) {
                return await send(sock, jid, { text: '❌ الرسالة دي مش عرض لمرة واحدة!' }, { quoted: msg });
            }

            let buffer = Buffer.from([]);
            try {
                const stream = await downloadContentFromMessage(mediaMessage, mediaType === 'sticker' ? 'sticker' : mediaType);
                for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
            } catch (e) {
                const fullMsg = {
                    key: { remoteJid: jid, id: contextInfo.stanzaId, participant: contextInfo.participant },
                    message: quoted
                };
                buffer = await downloadMediaMessage(fullMsg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
            }

            if (!buffer || buffer.length < 100) {
                return await send(sock, jid, { text: '❌ الوسائط فاضية أو مش مكتملة.' }, { quoted: msg });
            }

            if (mediaType === 'image') await send(sock, jid, { image: buffer, caption: '👀 *تم استخراج الصورة*' }, { quoted: msg });
            else if (mediaType === 'video') await send(sock, jid, { video: buffer, caption: '👀 *تم استخراج الفيديو*', mimetype: mediaMessage.mimetype || 'video/mp4' }, { quoted: msg });
            else if (mediaType === 'audio') await send(sock, jid, { audio: buffer, mimetype: mediaMessage.mimetype || 'audio/ogg; codecs=opus', ptt: mediaMessage.ptt || false }, { quoted: msg });
            else if (mediaType === 'sticker') await send(sock, jid, { sticker: buffer }, { quoted: msg });
            else if (mediaType === 'document') await send(sock, jid, { document: buffer, mimetype: mediaMessage.mimetype, fileName: mediaMessage.fileName || 'file' }, { quoted: msg });

        } catch (error) {
            console.error('[عرض] Error:', error);
            await send(sock, jid, { text: '❌ حصل خطأ.\n' + (error?.message || '') }, { quoted: msg });
        }
    }]
]);

// ═══════════════ 5. معالجة الرسائل ═══════════════
async function handleMessage(sock, msg) {
    const jid = msg?.key?.remoteJid;
    if (!msg?.message || !jid || jid === 'status@broadcast') return;
    if (sentStore.has(msg.key.id)) return;

    const m = msg.message;
    if (m?.viewOnceMessage || m?.viewOnceMessageV2 || m?.viewOnceMessageV2Extension) {
        incomingStore.set(msg.key.id, msg);
        if (incomingStore.size > 50) incomingStore.delete(incomingStore.keys().next().value);
    }

    const text = extractText(msg);
    if (!text) return;

    const firstWord = text.split(/\s+/)[0];
    if (!commands.has(firstWord)) return;

    console.log(`📥 أمر: [${firstWord}]`);
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
