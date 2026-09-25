require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cmsApi = require('./api');
const voiceTranscriber = require('./voice_transcriber');
const dashboard = require('./server');

// Start Web Admin Dashboard Server
dashboard.start();

console.log('🚀 Initializing Punjab WASA WhatsApp Bot...');

// Global process error handlers
process.on('uncaughtException', (err) => {
    console.error('⚠️ Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ Unhandled Rejection:', reason?.message || reason);
});

// Helper to validate Pakistani mobile numbers
function extractValidMobile(rawPhone) {
    if (!rawPhone) return null;
    const digits = rawPhone.replace(/[^0-9]/g, '');

    if (digits.startsWith('923') && digits.length === 12) {
        return '+' + digits;
    }
    if (digits.startsWith('03') && digits.length === 11) {
        return '+92' + digits.substring(1);
    }
    if (digits.startsWith('3') && digits.length === 10) {
        return '+92' + digits;
    }
    return null;
}

// In-Memory User Conversation State Store
const userSessions = new Map();

function getSession(sender) {
    if (!userSessions.has(sender)) {
        userSessions.set(sender, { step: 'IDLE', history: [], data: {} });
    }
    return userSessions.get(sender);
}

function resetSession(sender) {
    userSessions.set(sender, { step: 'IDLE', history: [], data: {} });
}

function navigateTo(sender, newStep) {
    const session = getSession(sender);
    if (session.step !== newStep) {
        if (!session.history) session.history = [];
        session.history.push(session.step);
        session.step = newStep;
    }
}

function goBack(sender) {
    const session = getSession(sender);
    if (session.history && session.history.length > 0) {
        const previousStep = session.history.pop();
        session.step = previousStep;
        return previousStep;
    }
    session.step = 'IDLE';
    return 'IDLE';
}

let isClientReady = false;

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth'
    }),
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--single-process'
        ]
    }
});

// Safe helper to send replies
async function sendReply(msg, text) {
    try {
        if (msg.reply) {
            await msg.reply(text);
        } else {
            await client.sendMessage(msg.from, text);
        }
    } catch (err) {
        try {
            await client.sendMessage(msg.from, text);
        } catch (retryErr) {
            console.error('Failed to send message:', retryErr.message);
        }
    }
}

// Top cities quick list
const TOP_CITIES = [
    { id: 1, name: 'Lahore' },
    { id: 25, name: 'Faisalabad' },
    { id: 24, name: 'Rawalpindi' },
    { id: 23, name: 'Multan' },
    { id: 22, name: 'Gujranwala' },
    { id: 6, name: 'Sialkot' }
];

// Render Main Menu
async function renderMainMenu(msg) {
    const text = 
`👋 *Welcome to Punjab WASA Complaint Portal*

How can we assist you today? Please select a category (or record an *Urdu Voice Note* 🎙️):

1️⃣ 💧 *Water Supply Complaints* (No Water, Low Pressure, Contamination, Leakage)
2️⃣ 🚰 *Sewerage Complaints* (Blockage, Overflow, Missing Manhole, Ponding)
3️⃣ 💳 *Billing & Revenue Issues* (Wrong Bill, Payment Discrepancy, Name Change)
4️⃣ 🔍 *Track Complaint Status*
5️⃣ ❓ *Helpline & Info*

🎙️ *Pro-Tip:* You can also hold the WhatsApp Mic button and send an Urdu Voice Note!

_Reply with 1, 2, 3, 4, 5, or send a Voice Note._`;
    await sendReply(msg, text);
}

// Render City Selection Prompt
async function renderCityPrompt(msg) {
    let topCityStr = TOP_CITIES.map((c, idx) => `${idx + 1}️⃣ *${c.name}*`).join('\n');
    const promptText = 
`🏙️ *Select Your City in Punjab:*

${topCityStr}
7️⃣ *Other City* (Or type your City name directly)

_Reply with a number (1-6) OR type any Punjab city name (e.g., Multan, Rawalpindi, Sahiwal, Bahawalpur, etc.)._
_(Type *back* to go back, *home* for Main Menu)_`;
    await sendReply(msg, promptText);
}

// Render Account Number Prompt (Mandatory for Lahore, Optional for Other Cities)
async function renderAccountNoPrompt(msg, sender, customMsg = null) {
    if (customMsg) {
        await sendReply(msg, customMsg);
        return;
    }
    const session = getSession(sender);
    const cityName = session.data.cityName || 'Lahore';
    const isLahore = cityName.toLowerCase().includes('lahore') || session.data.cityId === 1;

    if (isLahore) {
        const text = 
`💳 *WASA Consumer Account Number (Mandatory for Lahore)*

Please enter your WASA Lahore Consumer/Account Number (e.g., \`1234567\` or \`ACC-2024-001234\`):

⚠️ *Note:* Account Number is required for Lahore complaints to verify your consumer record.
_(Type *back* to go back, *home* for Main Menu)_`;
        await sendReply(msg, text);
    } else {
        const text = 
`💳 *Consumer Account Number (Optional for ${cityName})*

Do you have a WASA Consumer/Account Number for ${cityName}? 
(e.g., \`ACC-2024-001234\` or \`1234567\`)

_Reply with your Account Number, or send *skip* if you don't have one._
_(Type *back* to go back, *home* for Main Menu)_`;
        await sendReply(msg, text);
    }
}

// Display QR Code & Update Dashboard
client.on('qr', (qr) => {
    console.log('\n📲 SCAN THIS QR CODE WITH YOUR WHATSAPP APP:\n');
    qrcode.generate(qr, { small: true });
    console.log('\nInstructions: Open WhatsApp -> Settings / Menu -> Linked Devices -> Link a Device.\n');
    dashboard.updateQR(qr);
});

client.on('authenticated', () => {
    console.log('✅ Authentication successful!');
    dashboard.addLog('SUCCESS', 'WhatsApp session authenticated successfully');
});

client.on('ready', () => {
    if (!isClientReady) {
        isClientReady = true;
        const phone = client.info?.wid?.user ? `+${client.info.wid.user}` : null;
        console.log('🎉 Punjab CMS WhatsApp Bot is ONLINE and ready!');
        dashboard.updateStatus('ONLINE', phone);
    }
});

client.on('disconnected', (reason) => {
    isClientReady = false;
    console.log('⚠️ Client was disconnected:', reason);
    dashboard.updateStatus('DISCONNECTED');
});

// Admin Reset Session Callback
dashboard.onResetSessionCallback = async () => {
    try {
        console.log('🔄 Admin requested session reset from Web Dashboard...');
        dashboard.addLog('WARN', 'Initiating session logout & fresh initialization');
        await client.logout();
    } catch (err) {
        console.warn('Logout error (session may already be cleared):', err.message);
    }
    try {
        await client.destroy();
    } catch (err) {}
    client.initialize();
};

client.on('message', async (msg) => {
    if (!msg || msg.isStatus || msg.from === 'status@broadcast') return;

    const sender = msg.from;
    const body = msg.body ? msg.body.trim() : '';
    const text = body.toLowerCase();
    const session = getSession(sender);

    // Try extracting real phone number from contact profile
    let detectedMobile = null;
    try {
        const contact = await msg.getContact();
        if (contact && contact.number) {
            detectedMobile = extractValidMobile(contact.number);
        }
    } catch (e) {}

    if (!detectedMobile) {
        detectedMobile = extractValidMobile(sender.split('@')[0]);
    }

    if (detectedMobile && !session.data.mobile) {
        session.data.mobile = detectedMobile;
    }

    // ====================================================
    // 🎙️ VOICE NOTE PROCESSING (URDU / ROMAN URDU / ENGLISH)
    // ====================================================
    if (msg.hasMedia && (msg.type === 'ptt' || msg.type === 'audio')) {
        try {
            await sendReply(msg, '🎙️ *Processing your Urdu Voice Note...*');
            
            let media = null;
            try {
                media = await msg.downloadMedia();
            } catch (dlErr) {
                // Ignore transient download error and proceed gracefully
            }

            const audioBuffer = (media && media.data) ? Buffer.from(media.data, 'base64') : null;
            const result = await voiceTranscriber.transcribeAndExtract(audioBuffer, media?.mimetype || 'audio/ogg');

            session.data.category = result.category;
            session.data.complaintTypeId = result.complaintTypeId;
            session.data.complaintSubtypeId = result.complaintSubtypeId;
            session.data.complaintSubtypeName = result.complaintSubtypeName;
            session.data.details = result.transcription || result.details;

            const voiceSummary = 
`🎙️ *Voice Note Received & Processed!*

📝 *Transcribed Audio:* "${result.transcription}"
📌 *Detected Category:* ${result.complaintSubtypeName}

Let's complete your registration:`;

            await sendReply(msg, voiceSummary);

            // Jump to City Selection
            navigateTo(sender, 'SELECT_CITY');
            await renderCityPrompt(msg);
            return;
        } catch (e) {
            console.error('Error handling voice note:', e?.message || e);
            await sendReply(msg, '🎙️ Voice Note received! Let\'s select your city to continue:');
            navigateTo(sender, 'SELECT_CITY');
            await renderCityPrompt(msg);
            return;
        }
    }

    // Global Reset Keywords
    if (text === 'home' || text === 'main' || text === 'menu' || text === 'reset' || text === '00') {
        resetSession(sender);
        await renderMainMenu(msg);
        return;
    }

    // Global Back Keywords
    if (text === 'back' || text === 'b' || text === 'prev' || text === '#') {
        const prevStep = goBack(sender);

        if (prevStep === 'IDLE') {
            await renderMainMenu(msg);
            return;
        }

        await renderStepPrompt(msg, sender);
        return;
    }

    try {
        switch (session.step) {

            // ==========================================
            // MAIN MENU
            // ==========================================
            case 'IDLE':
                if (text === '1' || text.includes('water')) {
                    session.data.category = 'WATER';
                    session.data.complaintTypeId = 2; // Operations API type
                    session.data.complaintTypeName = 'Water Supply';
                    await loadAndShowSubtypes(msg, sender, 'WATER');
                } 
                else if (text === '2' || text.includes('sewer')) {
                    session.data.category = 'SEWER';
                    session.data.complaintTypeId = 2; // Operations API type
                    session.data.complaintTypeName = 'Sewerage';
                    await loadAndShowSubtypes(msg, sender, 'SEWER');
                }
                else if (text === '3' || text.includes('bill') || text.includes('revenue')) {
                    session.data.category = 'REVENUE';
                    session.data.complaintTypeId = 1; // Revenue API type
                    session.data.complaintTypeName = 'Revenue / Billing';
                    await loadAndShowSubtypes(msg, sender, 'REVENUE');
                }
                else if (text === '4' || text.includes('track') || text.includes('status')) {
                    navigateTo(sender, 'TRACK_ENTER_ID');
                    await sendReply(msg, 
`🔍 *Track Complaint Status*

Please enter your *Complaint ID* (e.g., \`1234\`):

_(Type *back* to go back, *home* for Main Menu)_`
                    );
                } 
                else if (text === '5' || text.includes('help')) {
                    await sendReply(msg, 
`❓ *Punjab WASA Complaint System Help*

• Reply *1* for Water Supply Issues
• Reply *2* for Sewerage & Drainage Issues
• Reply *3* for Billing & Account Issues
• Reply *4* to Track Complaint Status
• Record an *Urdu Voice Note* 🎙️ anytime!
• Reply *back* to return to the previous screen.
• Reply *home* or *menu* anytime to restart.

📞 Emergency Helpline: 1334
🌐 Website: http://pwasa.wasalhr.pk`
                    );
                } 
                else {
                    await renderMainMenu(msg);
                }
                break;

            // ==========================================
            // TRACK COMPLAINT FLOW
            // ==========================================
            case 'TRACK_ENTER_ID':
                const complaintId = body.replace(/[^0-9]/g, '');
                if (!complaintId) {
                    await sendReply(msg, '⚠️ Invalid Complaint ID. Please enter numbers only (e.g., `1234`):\n\n_(Type *back* to go back, *home* for Main Menu)_');
                    return;
                }

                await sendReply(msg, '⏳ Fetching complaint status...');
                const trackRes = await cmsApi.trackComplaint(complaintId);

                if (trackRes.success && trackRes.data) {
                    const d = trackRes.data;
                    let timelineText = '';
                    if (d.timeline && d.timeline.length > 0) {
                        timelineText = '\n\n📜 *Timeline:*\n' + d.timeline.map(t => 
                            `• *${t.changeDateTime ? new Date(t.changeDateTime).toLocaleDateString() : ''}*: ${t.oldValue || 'Start'} ➔ *${t.newValue}* (${t.remarks || 'Updated'})`
                        ).join('\n');
                    }

                    const statusMsg = 
`📋 *Complaint Status Report*

🔹 *Ticket ID:* #${d.complaintId}
👤 *Complainant:* ${d.complainantName}
📞 *Mobile:* ${d.mobile}
💧 *Type:* ${d.complaintTypeName} - ${d.complaintSubtypeName}
📍 *Address:* ${d.address}, ${d.cityName} (${d.townName || ''})
STATUS: *${d.statusName.toUpperCase()}*
⚡ *Priority:* ${d.priorityName || 'Normal'}
📅 *Filed Date:* ${d.launchDateTime ? new Date(d.launchDateTime).toLocaleString() : 'N/A'}${timelineText}

_Type *home* or *menu* to return to the main menu._`;
                    
                    await sendReply(msg, statusMsg);
                    resetSession(sender);
                } else {
                    await sendReply(msg, `❌ ${trackRes.message || 'Complaint not found.'}\n\nPlease check the ID and try again.\n_(Type *back* to go back, *home* for Main Menu)_`);
                }
                break;

            // ==========================================
            // REGISTER COMPLAINT FLOW
            // ==========================================
            case 'SELECT_SUBTYPE':
                const selectedIdx = parseInt(text, 10) - 1;
                if (isNaN(selectedIdx) || selectedIdx < 0 || selectedIdx >= (session.subtypesList?.length || 0)) {
                    await sendReply(msg, `⚠️ Please enter a valid option number (1 to ${session.subtypesList?.length || 1}):\n_(Type *back* to go back, *home* for Main Menu)_`);
                    return;
                }

                const selectedSubtype = session.subtypesList[selectedIdx];
                session.data.complaintSubtypeId = selectedSubtype.id;
                session.data.complaintSubtypeName = selectedSubtype.name;

                // Prompt City Selection
                navigateTo(sender, 'SELECT_CITY');
                await renderCityPrompt(msg);
                break;

            case 'SELECT_CITY':
                const cIdx = parseInt(text, 10) - 1;
                if (!isNaN(cIdx) && cIdx >= 0 && cIdx < TOP_CITIES.length) {
                    const chosen = TOP_CITIES[cIdx];
                    session.data.cityId = chosen.id;
                    session.data.cityName = chosen.name;
                    await sendReply(msg, `✅ *City Selected:* ${chosen.name}`);
                } else {
                    await sendReply(msg, '⏳ Searching city database...');
                    const matchResult = await findMatchingCity(body);

                    if (matchResult && matchResult.city) {
                        session.data.cityId = matchResult.city.id;
                        session.data.cityName = matchResult.city.name;
                        await sendReply(msg, `✅ *City Selected:* ${matchResult.city.name}`);
                    } else if (matchResult && matchResult.matches && matchResult.matches.length > 0) {
                        session.cityMatches = matchResult.matches;
                        navigateTo(sender, 'SELECT_CITY_MATCH');
                        let matchStr = matchResult.matches.map((c, idx) => `${idx + 1}️⃣ *${c.name}*`).join('\n');
                        await sendReply(msg, `🏙️ *Multiple cities found matching "${body}". Please select your city:*\n\n${matchStr}\n\n_Reply with number (1-${matchResult.matches.length})._`);
                        return;
                    } else {
                        await sendReply(msg, `❌ City "${body}" not found. Please select from the list (1-6) or type a valid Punjab city name (e.g. Multan, Rawalpindi, Sahiwal):\n_(Type *back* to go back, *home* for Main Menu)_`);
                        return;
                    }
                }

                navigateTo(sender, 'ENTER_ACCOUNT_NO');
                await renderAccountNoPrompt(msg, sender);
                break;

            case 'SELECT_CITY_MATCH':
                const mIdx = parseInt(text, 10) - 1;
                if (isNaN(mIdx) || mIdx < 0 || mIdx >= (session.cityMatches?.length || 0)) {
                    await sendReply(msg, `⚠️ Please reply with a number (1 to ${session.cityMatches?.length || 1}):`);
                    return;
                }
                const chosenMatch = session.cityMatches[mIdx];
                session.data.cityId = chosenMatch.id;
                session.data.cityName = chosenMatch.name;
                await sendReply(msg, `✅ *City Selected:* ${chosenMatch.name}`);

                navigateTo(sender, 'ENTER_ACCOUNT_NO');
                await renderAccountNoPrompt(msg, sender);
                break;

            case 'ENTER_ACCOUNT_NO':
                const selectedCityId = session.data.cityId || 1;
                const cityName = session.data.cityName || 'Lahore';
                const isLahore = cityName.toLowerCase().includes('lahore') || selectedCityId === 1;

                if (text === 'skip' || text === 'no' || text === 'none') {
                    if (isLahore) {
                        await sendReply(msg, `⚠️ *Account Number is Mandatory for ${cityName} complaints!*\n\nPlease enter your valid WASA Lahore Consumer/Account Number (e.g., \`1234567\`):\n\n_(Type *back* to go back, *home* for Main Menu)_`);
                        return;
                    } else {
                        session.data.accountNo = null;
                    }
                } else if (body.length > 2) {
                    session.data.accountNo = body;
                    await sendReply(msg, `⏳ Looking up consumer details for Account #${body} in ${cityName}...`);
                    const lookupRes = await cmsApi.lookupConsumer(selectedCityId, body);

                    if (lookupRes.success && lookupRes.data && lookupRes.data.consumerFound) {
                        const cons = lookupRes.data;
                        session.data.complainantName = cons.consumerName;
                        session.data.address = cons.consumerAddress;
                        if (cons.townId) session.data.townId = cons.townId;
                        if (cons.subdivisionId) session.data.subdivisionId = cons.subdivisionId;

                        await sendReply(msg, `✅ *Account Verified!*\n\n👤 *Name:* ${cons.consumerName}\n📍 *Address:* ${cons.consumerAddress}`);
                    } else {
                        if (isLahore) {
                            await sendReply(msg, `❌ *Account Number "${body}" Not Found in WASA ${cityName} Records!*\n\nPlease check your WASA bill and enter your Consumer/Account Number again:\n\n_(Type *back* to go back, *home* for Main Menu)_`);
                            return;
                        } else {
                            await sendReply(msg, 'ℹ️ Account number noted.');
                        }
                    }
                } else {
                    if (isLahore) {
                        await sendReply(msg, `⚠️ *Invalid Account Number!*\n\nPlease enter a valid WASA Lahore Consumer/Account Number (e.g., \`1234567\`):\n\n_(Type *back* to go back, *home* for Main Menu)_`);
                        return;
                    } else {
                        session.data.accountNo = null;
                    }
                }

                if (!session.data.mobile) {
                    navigateTo(sender, 'ENTER_MOBILE');
                    await sendReply(msg, '📱 *Contact Mobile Number*\n\nPlease enter your contact phone number (e.g. `03001234567`):\n\n_(Type *back* to go back, *home* for Main Menu)_');
                } else if (session.data.complainantName) {
                    navigateTo(sender, 'ENTER_DETAILS');
                    await sendReply(msg, `📝 *Complaint Description*\n\nPlease describe the problem details (minimum 10 characters):\n\n_(Type *back* to go back, *home* for Main Menu)_`);
                } else {
                    navigateTo(sender, 'ENTER_NAME');
                    await sendReply(msg, '👤 *Please enter your Full Name:*\n\n_(Type *back* to go back, *home* for Main Menu)_');
                }
                break;

            case 'ENTER_MOBILE':
                const validPhone = extractValidMobile(body);
                if (!validPhone) {
                    await sendReply(msg, '⚠️ Invalid mobile number. Please enter a valid Pakistani mobile number (e.g., `03001234567` or `03219876543`):\n\n_(Type *back* to go back, *home* for Main Menu)_');
                    return;
                }
                session.data.mobile = validPhone;

                if (session.data.complainantName) {
                    navigateTo(sender, 'ENTER_DETAILS');
                    await sendReply(msg, '📝 *Complaint Description*\n\nPlease describe the problem details (minimum 10 characters):\n\n_(Type *back* to go back, *home* for Main Menu)_');
                } else {
                    navigateTo(sender, 'ENTER_NAME');
                    await sendReply(msg, '👤 *Please enter your Full Name:*\n\n_(Type *back* to go back, *home* for Main Menu)_');
                }
                break;

            case 'ENTER_NAME':
                if (body.length < 3) {
                    await sendReply(msg, '⚠️ Please enter a valid full name (at least 3 letters):\n_(Type *back* to go back, *home* for Main Menu)_');
                    return;
                }
                session.data.complainantName = body;
                navigateTo(sender, 'ENTER_ADDRESS');
                await sendReply(msg, '📍 *Please enter your location address (or attach your WhatsApp Location Pin 📍):*\n\n_(Type *back* to go back, *home* for Main Menu)_');
                break;

            case 'ENTER_ADDRESS':
                if (msg.type === 'location' || msg.location) {
                    const lat = msg.location.latitude;
                    const lng = msg.location.longitude;
                    session.data.latitude = lat;
                    session.data.longitude = lng;

                    await sendReply(msg, '⏳ Mapping GPS location pin to street address...');
                    const geoAddress = await cmsApi.reverseGeocode(lat, lng);
                    session.data.address = geoAddress;

                    await sendReply(msg, `📍 *GPS Location Received!*\n🏠 *Address:* ${geoAddress}`);

                    if (session.data.details && session.data.details.length >= 8) {
                        navigateTo(sender, 'UPLOAD_IMAGE');
                        await sendReply(msg, '📸 *Upload Photo (Optional)*\n\nYou can send a photo of the issue right now, or send *skip* to submit without a photo.');
                    } else {
                        navigateTo(sender, 'ENTER_DETAILS');
                        await sendReply(msg, '📝 *Please describe the problem details (minimum 10 characters):*\n\n_(Type *back* to go back, *home* for Main Menu)_');
                    }
                } else {
                    if (body.length < 5) {
                        await sendReply(msg, '⚠️ Please enter a detailed address (house/street/area) or attach a WhatsApp Location Pin:\n_(Type *back* to go back, *home* for Main Menu)_');
                        return;
                    }
                    session.data.address = body;
                    
                    if (session.data.details && session.data.details.length >= 8) {
                        navigateTo(sender, 'UPLOAD_IMAGE');
                        await sendReply(msg, '📸 *Upload Photo (Optional)*\n\nYou can send a photo of the issue right now, or send *skip* to submit without a photo.');
                    } else {
                        navigateTo(sender, 'ENTER_DETAILS');
                        await sendReply(msg, '📝 *Please describe the problem details (minimum 10 characters):*\n\n_(Type *back* to go back, *home* for Main Menu)_');
                    }
                }
                break;

            case 'ENTER_DETAILS':
                if (body.length < 10) {
                    await sendReply(msg, '⚠️ Description too short. Please enter at least 10 characters explaining the problem (or send a Voice Note 🎙️):\n_(Type *back* to go back, *home* for Main Menu)_');
                    return;
                }
                session.data.details = body;
                navigateTo(sender, 'UPLOAD_IMAGE');

                await sendReply(msg, 
`📸 *Upload Photo (Optional)*

You can send a **photo of the issue** right now, or send *skip* to submit without a photo.

_(Type *back* to go back, *home* for Main Menu)_`
                );
                break;

            case 'UPLOAD_IMAGE':
                let imageBuffer = null;
                let imageName = 'photo.jpg';

                if (msg.hasMedia) {
                    try {
                        const media = await msg.downloadMedia();
                        if (media && media.mimetype && media.mimetype.startsWith('image/')) {
                            imageBuffer = Buffer.from(media.data, 'base64');
                            imageName = `photo_${Date.now()}.${media.mimetype.split('/')[1] || 'jpg'}`;
                            await sendReply(msg, '📸 Photo received!');
                        }
                    } catch (e) {
                        console.error('Error downloading media:', e.message);
                    }
                }

                const payload = {
                    complainantName: session.data.complainantName || 'Consumer',
                    mobile: session.data.mobile || '+923000000000',
                    accountNo: session.data.accountNo || null,
                    address: session.data.address || 'Address Not Provided',
                    cityId: session.data.cityId || 1,
                    townId: session.data.townId || null,
                    subdivisionId: session.data.subdivisionId || null,
                    complaintTypeId: session.data.complaintTypeId || 2,
                    complaintSubtypeId: session.data.complaintSubtypeId || 23,
                    details: session.data.details || 'Complaint submitted via WhatsApp Voice Note',
                    latitude: session.data.latitude || null,
                    longitude: session.data.longitude || null
                };

                await sendReply(msg, `⏳ Submitting your complaint to Punjab CMS portal (${session.data.cityName || 'City'})...`);

                const createRes = await cmsApi.createComplaint(payload, imageBuffer, imageName);

                if (createRes.success && createRes.data) {
                    const c = {
                        ...createRes.data,
                        category: session.data.category || (session.data.complaintTypeId === 1 ? 'REVENUE' : 'WATER'),
                        complaintTypeName: createRes.data.complaintTypeName || session.data.complaintTypeName,
                        complaintSubtypeName: createRes.data.complaintSubtypeName || session.data.complaintSubtypeName,
                        cityName: createRes.data.cityName || session.data.cityName
                    };
                    dashboard.recordComplaint(c);
                    const confirmationMsg = 
`✅ *COMPLAINT REGISTERED SUCCESSFULLY!*

🎉 *Ticket ID:* \`#${c.complaintId}\`
🏙️ *City:* ${c.cityName || session.data.cityName}
👤 *Complainant:* ${c.complainantName}
📞 *Mobile:* ${c.mobile}
💧 *Type:* ${c.complaintTypeName} - ${c.complaintSubtypeName}
📍 *Address:* ${c.address}
STATUS: *${(c.statusName || 'LAUNCHED').toUpperCase()}*

_Our field team in ${c.cityName || session.data.cityName} has been notified. You can send *home* to return to main menu or send your Ticket ID anytime to track progress._`;

                    await sendReply(msg, confirmationMsg);
                } else {
                    let errorDetails = createRes.errorList && createRes.errorList.length > 0 
                        ? createRes.errorList.join('\n• ') 
                        : (createRes.message || 'Failed to submit complaint.');

                    await sendReply(msg, `⚠️ *Submission Error:*\n• ${errorDetails}\n\nPlease type *home* to try again or call helpline 1334.`);
                }

                resetSession(sender);
                break;

            default:
                resetSession(sender);
                await renderMainMenu(msg);
                break;
        }

    } catch (err) {
        console.error('Error handling WhatsApp message:', err?.message || err);
        await sendReply(msg, '⚠️ An unexpected error occurred. Type *home* to start over.');
        resetSession(sender);
    }
});

/**
 * Match user city search input dynamically against 41 cities from API
 */
async function findMatchingCity(query) {
    const res = await cmsApi.getCities();
    if (!res.success || !res.data) return null;
    const cities = res.data;
    const q = query.trim().toLowerCase();

    let match = cities.find(c => c.name.trim().toLowerCase() === q);
    if (match) return { city: match, matches: [match] };

    const matches = cities.filter(c => c.name.trim().toLowerCase().includes(q));
    if (matches.length === 1) return { city: matches[0], matches };
    if (matches.length > 1) return { city: null, matches };

    return null;
}

/**
 * Fetch subtypes from API and filter according to category
 */
async function loadAndShowSubtypes(msg, sender, category) {
    const session = getSession(sender);
    const typeId = category === 'REVENUE' ? 1 : 2;

    await sendReply(msg, `⏳ Loading options...`);
    const res = await cmsApi.getComplaintSubtypes(typeId);

    let allSubtypes = res.success && res.data ? res.data : [];
    let filtered = [];

    if (category === 'WATER') {
        const waterKeywords = ['water', 'pipe', 'leakage', 'pressure', 'bursting', 'shortage'];
        filtered = allSubtypes.filter(s => {
            const name = s.name.toLowerCase();
            return waterKeywords.some(kw => name.includes(kw));
        });
        if (filtered.length === 0) {
            filtered = [
                { id: 17, name: 'Contaminated Water' },
                { id: 23, name: 'Water Shortage / Low Pressure' },
                { id: 20, name: 'Pipe Leakage / Bursting' }
            ];
        }
    } else if (category === 'SEWER') {
        const sewerKeywords = ['sewer', 'blockage', 'overflow', 'manhole', 'ponding', 'silting', 'drainage'];
        filtered = allSubtypes.filter(s => {
            const name = s.name.toLowerCase();
            return sewerKeywords.some(kw => name.includes(kw));
        });
        if (filtered.length === 0) {
            filtered = [
                { id: 22, name: 'Sewer Blockage / Overflow' },
                { id: 1, name: 'Manhole Missing / Broken' },
                { id: 19, name: 'De-Silting (Drainage)' },
                { id: 21, name: 'Ponding' }
            ];
        }
    } else if (category === 'REVENUE') {
        filtered = allSubtypes;
    }

    session.subtypesList = filtered;
    navigateTo(sender, 'SELECT_SUBTYPE');

    let optionsStr = filtered.map((s, idx) => `${idx + 1}️⃣ *${s.name}*`).join('\n');
    let title = category === 'WATER' ? '💧 *Water Supply Issue Categories:*' :
                category === 'SEWER' ? '🚰 *Sewerage & Drainage Issue Categories:*' :
                '💳 *Billing & Revenue Issue Categories:*';

    await sendReply(msg, `${title}\n\n${optionsStr}\n\n_Reply with option number (1-${filtered.length})._\n_(Type *back* to go back, *home* for Main Menu)_`);
}

/**
 * Re-render prompt when user presses "back"
 */
async function renderStepPrompt(msg, sender) {
    const session = getSession(sender);
    switch (session.step) {
        case 'SELECT_SUBTYPE':
            let optionsStr = session.subtypesList ? session.subtypesList.map((s, idx) => `${idx + 1}️⃣ *${s.name}*`).join('\n') : '1️⃣ General Issue';
            await sendReply(msg, `📋 *Select Specific Issue Category:*\n\n${optionsStr}\n\n_(Type *back* to go back, *home* for Main Menu)_`);
            break;
        case 'SELECT_CITY':
            await renderCityPrompt(msg);
            break;
        case 'ENTER_ACCOUNT_NO':
            await renderAccountNoPrompt(msg, sender);
            break;
        case 'ENTER_MOBILE':
            await sendReply(msg, `📱 *Contact Mobile Number*\n\nPlease enter your contact phone number (e.g. \`03001234567\`):\n\n_(Type *back* to go back, *home* for Main Menu)_`);
            break;
        case 'ENTER_NAME':
            await sendReply(msg, `👤 *Please enter your Full Name:*\n\n_(Type *back* to go back, *home* for Main Menu)_`);
            break;
        case 'ENTER_ADDRESS':
            await sendReply(msg, `📍 *Please enter your location address (or attach your WhatsApp Location Pin 📍):*\n\n_(Type *back* to go back, *home* for Main Menu)_`);
            break;
        case 'ENTER_DETAILS':
            await sendReply(msg, `📝 *Please describe the problem details (minimum 10 characters):*\n\n_(Type *back* to go back, *home* for Main Menu)_`);
            break;
        case 'TRACK_ENTER_ID':
            await sendReply(msg, `🔍 *Track Complaint Status*\n\nPlease enter your Complaint ID (e.g. \`1234\`):\n\n_(Type *back* to go back, *home* for Main Menu)_`);
            break;
        default:
            await renderMainMenu(msg);
            break;
    }
}

// Start Client
client.initialize();
