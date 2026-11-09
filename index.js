const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const QRCode = require('qrcode');

// --- DATABASE SEMENTARA (MEMORY) ---
const ownerNumber = '62gantinomerkamutanpa0atau+62tapihanya6281xxxx'; 
const registeredUsers = new Set([ownerNumber]); // Daftar nomor yang "dikecualikan" (Whitelist)
let isBotBusy = false; 
const busyReplied = new Set(); 

// Fungsi bantuan untuk mengubah 08xxx menjadi 628xxx
function formatNomor(nomor) {
    let n = nomor.replace(/[^0-9]/g, '');
    if (n.startsWith('08')) n = '62' + n.slice(1);
    return n;
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('skuntul2nya');

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        syncFullHistory: false,
        markOnlineOnConnect: true,
        patchMessageBeforeSending: (message) => {
            const requiresPatch = !!(message.buttonsMessage || message.templateMessage || message.listMessage);
            if (requiresPatch) {
                message = { viewOnceMessage: { message: { messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 }, ...message } } };
            }
            return message;
        }
    });

    // --- FITUR AUTO-REJECT TELEPON ---
    sock.ev.on('call', async (calls) => {
        if (isBotBusy) {
            for (let call of calls) {
                if (call.status === 'offer') {
                    let callerNum = call.from.split('@')[0];
                    
                    // Jika penelepon ada di daftar Whitelist, biarkan berdering (jangan ditolak)
                    if (registeredUsers.has(callerNum)) {
                        console.log(`[habibGM] Panggilan masuk diizinkan dari nomor whitelist: ${callerNum}`);
                        continue;
                    }

                    // Jika tidak terdaftar, tolak panggilan
                    console.log(`[habibGM] Panggilan ditolak dari: ${callerNum}`);
                    await sock.rejectCall(call.id, call.from);
                    await sock.sendMessage(call.from, { text: 'lagi sibuk jangan ganggu' });
                }
            }
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            QRCode.toFile('WhatsApp.png', qr, { width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } }, (err) => {
                if (err) console.error('❌ Gagal membuat file QR Code:', err);
                else console.log('📱 QR Code berhasil disimpan sebagai "WhatsApp.png"!');
            });
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error = new Boom(lastDisconnect.error))?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('✅ Bot berhasil terhubung ke WhatsApp!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message) return;

        const chatJid = m.key.remoteJid;
        const isFromMe = m.key.fromMe;
        const msgText = m.message.conversation || m.message.extendedTextMessage?.text;

        if (!msgText) return;

        // Identifikasi Nomor Pengirim yang Valid
        let senderNumber = '';
        if (isFromMe) {
            senderNumber = sock.user.id.split(':')[0]; 
        } else if (chatJid.endsWith('@g.us')) {
            senderNumber = m.key.participant.split('@')[0];
        } else {
            senderNumber = chatJid.split('@')[0];
        }

        const isGroup = chatJid.endsWith('@g.us');
        const isOwner = (senderNumber === ownerNumber);

        if (!isFromMe) {
            await sock.readMessages([m.key]);
            await sock.sendPresenceUpdate('available', chatJid);
        }

        // --- FITUR AUTO-REPLY CHAT PRIBADI ---
        if (isBotBusy && !isGroup && !isFromMe) {
            // Jika nomor pengirim TIDAK ADA di whitelist, maka balas otomatis
            if (!registeredUsers.has(senderNumber)) {
                if (!busyReplied.has(senderNumber)) {
                    await sock.sendMessage(chatJid, { text: 'orange lagi main game RF online jadi jangan di ganggu.' });
                    busyReplied.add(senderNumber);
                    
                    // Jeda 15 menit sebelum membalas orang yang sama
                    setTimeout(() => { busyReplied.delete(senderNumber); }, 15 * 60 * 1000);
                }
            }
        }

        // --- SISTEM PERINTAH (HANYA OWNER YANG BISA PAKAI) ---
        if (!isOwner) return; // Jika yang ngetik perintah bukan Owner, hentikan!

        const args = msgText.trim().split(/ +/);
        const command = args.shift().toLowerCase();

        switch (command) {
            case 'help':
                await sock.sendPresenceUpdate('composing', chatJid);
                const menu = `🤖 *Sistem Kontrol Owner*\n\n*daftar <nomor>* - Daftarkan nomor (Bypass Mode Sibuk).\n*hapus <nomor/semua>* - Hapus daftar nomor.\n*list* - Lihat nomor yang didaftarkan.\n*sibuk* - Aktifkan Mode Jangan Ganggu (DND).\n*normal* - Matikan Mode Jangan Ganggu.`;
                await sock.sendMessage(chatJid, { text: menu });
                break;

            case 'daftar':
                if (args.length < 1) {
                    await sock.sendMessage(chatJid, { text: '⚠️ Format salah. Contoh: daftar 085xxxxxxxxx' });
                    return;
                }
                let newNum = formatNomor(args[0]);
                if (registeredUsers.has(newNum)) {
                    await sock.sendMessage(chatJid, { text: `✅ Nomor ${newNum} sudah ada di daftar Whitelist.` });
                } else {
                    registeredUsers.add(newNum);
                    await sock.sendMessage(chatJid, { text: `🎉 Nomor ${newNum} berhasil didaftarkan.\nSekarang nomor ini bebas menelepon/chat Anda meskipun Mode Sibuk sedang aktif.` });
                }
                break;

            case 'sibuk':
                isBotBusy = true;
                busyReplied.clear();
                await sock.sendMessage(chatJid, { text: '🔕 *MODE SIBUK AKTIF*\nSemua telepon dari nomor tak terdaftar akan otomatis ditolak dan dibalas otomatis.' });
                break;

            case 'normal':
            case 'online':
                isBotBusy = false;
                busyReplied.clear();
                await sock.sendMessage(chatJid, { text: '🔔 *MODE NORMAL*\nMode sibuk dimatikan. Telepon dan chat masuk kembali normal.' });
                break;

            case 'list':
                let listText = '📋 *Daftar Nomor Pengecualian (Whitelist):*\n\n';
                registeredUsers.forEach(num => { listText += `• ${num}\n`; });
                await sock.sendMessage(chatJid, { text: listText });
                break;

            case 'hapus':
                if (args.length < 1) {
                    await sock.sendMessage(chatJid, { text: '⚠️ Format salah. Contoh:\n- hapus 085xxxxxxxxx\n- hapus semua' });
                    return;
                }

                const target = args[0].toLowerCase();
                if (target === 'semua') {
                    registeredUsers.clear();
                    registeredUsers.add(ownerNumber); // Owner jangan sampai ikut terhapus
                    await sock.sendMessage(chatJid, { text: '🗑️ Semua daftar pengguna berhasil dihapus (kecuali Owner).' });
                } else {
                    let numToDelete = formatNomor(target);
                    
                    if (numToDelete === ownerNumber) {
                        await sock.sendMessage(chatJid, { text: '❌ Anda tidak bisa menghapus nomor Anda sendiri.' });
                    } else if (registeredUsers.has(numToDelete)) {
                        registeredUsers.delete(numToDelete);
                        await sock.sendMessage(chatJid, { text: `✅ Nomor ${numToDelete} berhasil dihapus dari list.` });
                    } else {
                        await sock.sendMessage(chatJid, { text: `❌ Nomor ${numToDelete} tidak ditemukan di list.` });
                    }
                }
                break;
        }
    });
}

connectToWhatsApp();
