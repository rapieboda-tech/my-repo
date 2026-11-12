import fs from 'fs';
import path from 'path';

export default {
    command: ['تست', 'test'],
    elite: false,

    execute: async ({ sock, chatId, msg }) => {
        
        // مسار الصورة
        const thumbnailPath = path.join(process.cwd(), 'media', 'kaido.png');
        let thumbnail = null;

        // التأكد إن الصورة موجودة عشان ميعملش كراش
        if (fs.existsSync(thumbnailPath)) {
            thumbnail = fs.readFileSync(thumbnailPath);
        } else {
            console.log("⚠️ تحذير: صورة kaido.png مش موجودة!");
        }

        await sock.sendMessage(
            chatId,
            {
                text: '> 𝑲𝒂𝒊𝒅𝒐 𝐁𝐨𝐭 𝐢𝐬 𝐨𝐧𝐥𝐢𝐧𝐞 🌹',
                contextInfo: {
                    externalAdReply: {
                        title: '𝑲𝒂𝒊𝒅𝒐 𝐁𝐎𝐓',
                        body: '𝑲𝒂𝒊𝒅𝒐 𝐒𝐘𝐒𝐓𝐄𝐌',
                        thumbnail: thumbnail, 
                        mediaType: 1,
                        renderLargerThumbnail: true, 
                        showAdAttribution: false
                    }
                }
            },
            { quoted: msg }
        );
    }
};
