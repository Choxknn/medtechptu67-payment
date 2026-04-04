const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { google } = require('googleapis');
const { Readable } = require('stream');
const axios = require('axios');
const FormData = require('form-data');

// เริ่มต้น Firebase Admin
admin.initializeApp();


// ==========================================
// ⚙️ ตั้งค่าระบบ (ดึงจากไฟล์ .env)
// ==========================================
const TARGET_EWALLET = process.env.TARGET_EWALLET;
const SLIPOK_API_URL = process.env.SLIPOK_API_URL;
const SLIPOK_API_KEY = process.env.SLIPOK_API_KEY;
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const LINE_TARGET_ID = process.env.LINE_TARGET_ID;
const STUDENT_LINE_ACCESS_TOKEN = process.env.STUDENT_LINE_ACCESS_TOKEN;

// ==========================================
// 📂 ตั้งค่าการเชื่อมต่อ Google Drive
// ==========================================
const SERVICE_ACCOUNT_EMAIL = process.env.SERVICE_ACCOUNT_EMAIL || "";
const SERVICE_ACCOUNT_KEY = (process.env.SERVICE_ACCOUNT_KEY || "").replace(/\\n/g, '\n');
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || "";

const auth = new google.auth.JWT(
    SERVICE_ACCOUNT_EMAIL, null, SERVICE_ACCOUNT_KEY,
    ['https://www.googleapis.com/auth/drive']
);
const drive = google.drive({ version: 'v3', auth });

// ==========================================
// 🚀 API ROUTER (รับคำสั่งจาก React + Firebase)
// ==========================================
exports.apiRouter = functions.https.onRequest(async (req, res) => {
    // ปลดล็อค CORS
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    try {
        // 🌟 แก้ไขตรงนี้: ดักจับข้อมูลที่ส่งมาจากหน้าเว็บให้เหมือนตอนใช้ GAS
        let params;
        if (typeof req.body === 'string') {
            params = JSON.parse(req.body);
        } else if (req.body && req.body.data) {
            params = JSON.parse(req.body.data);
        } else {
            params = req.body;
        }
        
        const action = params.action;
        const args = params.args || [];
        
        let result = {};

        if (action === 'submitPaymentViaFirebase') { result = await submitPaymentViaFirebase(args[0]); }
        else if (action === 'submitOrderWithSlipViaFirebase') { result = await submitOrderWithSlipViaFirebase(args[0]); }
        else if (action === 'sendRecoveryLineMessage') { result = await sendRecoveryLineMessage(args[0]); }
        else if (action === 'uploadToDrive') { result = await uploadToDriveAPI(args[0]); }
        else if (action === 'notifyPayment') { result = await notifyPayment(args[0]); }
        else if (action === 'notifyOrder') { result = await notifyOrder(args[0]); }
        else if (action === 'getCustomToken') { result = await getCustomToken(args); }
        else {
            result = { success: false, message: 'ไม่พบคำสั่ง (Action) นี้ในระบบ' };
        }

        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.toString() });
    }
});

// ==========================================
// 🔑 ฟังก์ชันสร้าง Firebase Custom Token
// ==========================================
async function getCustomToken(args) {
    try {
        const uid = args.uid || args.lineId || args[0]?.uid || args[0]?.lineId;
        if (!uid) return { success: false, message: 'ไม่พบ UID ที่ส่งมา' };

        // ใน Node.js เราสามารถใช้ Firebase Admin สร้าง Token ได้ในบรรทัดเดียว (แทนการเข้ารหัส 50 บรรทัดแบบ GAS)
        const customToken = await admin.auth().createCustomToken(String(uid));
        
        return { success: true, token: customToken };
    } catch (e) {
        console.error("Token Generation Error:", e);
        return { success: false, message: "สร้าง Token ไม่สำเร็จ: " + e.toString() };
    }
}

// ==========================================
// 🌟 สร้างฟังก์ชันสำหรับรับคำสั่งส่ง LINE
// ==========================================
async function notifyPayment(data) {
    await sendPaymentNotification(data.payload, data.status, data.slipUrl, data.isUnderpaid, data.actualAmount, data.isOverpaid, data.message);
    return { success: true };
}
async function notifyOrder(data) {
    await sendOrderNotification(data.payload, data.orderId, data.slipUrl, data.actualAmount);
    return { success: true };
}

// ==========================================
// 📦 ฟังก์ชันแกนหลักสำหรับอัปโหลดรูปลง Google Drive
// ==========================================
async function uploadToDriveCore(fileData, fileName, mimeType) {
    const buffer = Buffer.from(fileData, 'base64');
    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);

    const fileMetadata = {
        name: fileName || "file.jpg",
        parents: [DRIVE_FOLDER_ID]
    };
    const media = {
        mimeType: mimeType || 'image/jpeg',
        body: stream
    };

    const driveFile = await drive.files.create({
        resource: fileMetadata,
        media: media,
        fields: 'id, webViewLink'
    });

    await drive.permissions.create({
        fileId: driveFile.data.id,
        requestBody: { role: 'reader', type: 'anyone' }
    });

    return { slipUrl: driveFile.data.webViewLink, buffer: buffer };
}

// ==========================================
// 1️⃣ ฟังก์ชันตรวจสอบสลิปจ่ายบิล 
// ==========================================
async function submitPaymentViaFirebase(payload) {
    try {
        const expectedTotal = Number(payload.total);
        const { slipUrl, buffer } = await uploadToDriveCore(payload.fileData, payload.fileName, payload.mimeType);
        const verification = await checkSlipWithSlipOK(buffer, expectedTotal);

        if (verification.isSystemError) {
            return { 
                success: true, status: 'รอตรวจสอบ', message: 'ระบบตรวจสลิปอัตโนมัติขัดข้อง (รอแอดมินตรวจสอบด้วยตนเอง)', 
                transRef: "MANUAL-" + new Date().getTime(), slipUrl: slipUrl, actualAmount: expectedTotal,
                isUnderpaid: false, isOverpaid: false 
            };
        }

        if (!verification.passed) return { success: false, message: verification.reason };

        let actualTransferAmount = Number(verification.data.amount);
        let transRef = String(verification.data.transRef);
        let isOverpaid = actualTransferAmount > expectedTotal;
        let status = verification.isUnderpaid ? 'ยอดไม่ครบ' : (isOverpaid ? 'รอตรวจสอบ' : 'ชำระแล้ว');

        return { 
            success: true, status: status, message: verification.warning || '', 
            transRef: transRef, slipUrl: slipUrl, actualAmount: actualTransferAmount, 
            isUnderpaid: verification.isUnderpaid, isOverpaid: isOverpaid 
        };
    } catch (e) {
        return { success: false, message: "ระบบขัดข้อง: " + e.toString() };
    }
}

// ==========================================
// 2️⃣ ฟังก์ชันตรวจสอบสลิปสั่งซื้อสินค้า 
// ==========================================
async function submitOrderWithSlipViaFirebase(payload) {
    try {
        const expectedTotal = Number(payload.total);
        const { slipUrl, buffer } = await uploadToDriveCore(payload.fileData, payload.fileName, payload.mimeType);
        const verification = await checkSlipWithSlipOK(buffer, expectedTotal);
        
        const orderId = 'ORD-' + new Date().getTime().toString().substr(-6);

        if (verification.isSystemError) {
            return { success: true, orderId: orderId, transRef: "MANUAL-" + new Date().getTime(), slipUrl: slipUrl, actualAmount: expectedTotal };
        }

        if (!verification.passed) return { success: false, message: verification.reason };

        const actualTransferAmount = Number(verification.data.amount);
        const transRef = String(verification.data.transRef);

        return { success: true, orderId: orderId, transRef: transRef, slipUrl: slipUrl, actualAmount: actualTransferAmount };
    } catch (e) {
        return { success: false, message: "ระบบขัดข้อง: " + e.toString() };
    }
}

// ==========================================
// 3️⃣ ฟังก์ชันส่ง LINE กู้คืนรหัสผ่าน
// ==========================================
async function sendRecoveryLineMessage(payload) {
    try {
        const recoveryFlex = createRecoveryFlex(payload);
        const result = await sendLineMessage(STUDENT_LINE_ACCESS_TOKEN, payload.lineId, [recoveryFlex]);
        
        if (result.success) {
            return { success: true };
        } else {
            return { success: false, message: 'ส่ง LINE ไม่ผ่าน: ' + result.error };
        }
    } catch (e) {
        return { success: false, message: e.toString() };
    }
}

// ==========================================
// 📦 ฟังก์ชันสำหรับรับไฟล์ Base64 เซฟลง Google Drive (Direct URL)
// ==========================================
async function uploadToDriveAPI(data) {
    try {
        const { slipUrl } = await uploadToDriveCore(data.fileData, data.fileName, data.mimeType);
        return { success: true, slipUrl: slipUrl };
    } catch (e) {
        return { success: false, error: e.toString() };
    }
}

// ==========================================
// 🔍 ระบบตรวจสลิป (SlipOK Core Logic)
// ==========================================
async function checkSlipWithSlipOK(buffer, expectedAmount) {
    try {
        const form = new FormData();
        form.append('files', buffer, { filename: 'slip.jpg', contentType: 'image/jpeg' });

        const response = await axios.post(SLIPOK_API_URL, form, {
            headers: { ...form.getHeaders(), "x-authorization": SLIPOK_API_KEY },
            validateStatus: () => true 
        });

        const json = response.data;
        if (response.status !== 200 || json.success === false) {
            const errorMsg = json.message || 'ไม่พบ QR Code หรือไม่ใช่สลิปโอนเงินที่ถูกต้อง';
            return { passed: false, reason: errorMsg, isFatal: true };
        }
        
        const data = json.data;

        const receiverId = (data.receiver && data.receiver.proxy && data.receiver.proxy.value) 
            ? data.receiver.proxy.value 
            : ((data.receiver && data.receiver.account && data.receiver.account.value) ? data.receiver.account.value : '');
        
        if (!isAccountMatch(receiverId, TARGET_EWALLET)) {
            return { passed: false, reason: `บัญชีปลายทางไม่ถูกต้อง`, isFatal: true };
        }

        let warning = null;
        let missingAmount = 0;

        if (data.amount < expectedAmount) {
            missingAmount = expectedAmount - data.amount;
            warning = `ยอดโอนไม่ครบ (ขาด ${missingAmount.toFixed(2)})`;
        } 
        
        return { 
            passed: true, status: 'ชำระแล้ว', data: data, 
            isUnderpaid: (missingAmount > 0), missingAmount: missingAmount, warning: warning
        };
    } catch (e) {
        console.error("Slip Error: " + e.toString());
        return { isSystemError: true }; 
    }
}

function isAccountMatch(slipValue, targetValue) {
    if (!slipValue) return false;
    const cleanSlip = String(slipValue).replace(/[^0-9xX]/g, ''); 
    const cleanTarget = String(targetValue).replace(/[^0-9]/g, '');

    if (cleanSlip === cleanTarget) return true;
    if (cleanSlip.length >= 4 && cleanTarget.length >= 4) {
        if (cleanSlip.slice(-4) === cleanTarget.slice(-4)) return true; 
    }
    return false;
}

// ==========================================
// 💬 ระบบส่ง LINE Notifications
// ==========================================
async function sendPaymentNotification(payload, status, fileUrl, isUnderpaid, actualAmount, isOverpaid, note) {
    const formattedTotal = Number(payload.total).toLocaleString('th-TH', {minimumFractionDigits: 2});
    const actualFmt = Number(actualAmount).toLocaleString('th-TH', {minimumFractionDigits: 2});
    
    let headerColor = (status === 'ชำระแล้ว') ? "#06C755" : "#F59E0B";
    let adminTitle = (status === 'ชำระแล้ว') ? `✅ รับยอดแล้ว ${formattedTotal}` : `⚠️ รอตรวจสอบ ${formattedTotal}`;
    
    if (isUnderpaid) {
        headerColor = "#EF4444";
        adminTitle = `⚠️ ยอดไม่ครบ (โอน ${actualFmt})`;
    } else if (isOverpaid) {
        headerColor = "#F59E0B";
        adminTitle = `⚠️ ยอดเกิน (โอน ${actualFmt})`;
    }

    const adminFlex = {
        "type": "flex", "altText": adminTitle,
        "contents": {
            "type": "bubble", "size": "mega",
            "header": { "type": "box", "layout": "horizontal", "backgroundColor": headerColor, "paddingAll": "15px", "contents": [{ "type": "text", "text": adminTitle, "weight": "bold", "color": "#FFFFFF", "size": "md", "flex": 1, "wrap": true }] },
            "hero": { "type": "image", "url": fileUrl, "size": "full", "aspectRatio": "20:13", "aspectMode": "cover", "action": { "type": "uri", "uri": fileUrl } },
            "body": {
                "type": "box", "layout": "vertical", "paddingAll": "15px", "spacing": "sm",
                "contents": [
                    { "type": "box", "layout": "baseline", "contents": [{ "type": "text", "text": "ผู้โอน", "color": "#888888", "size": "sm", "flex": 2 }, { "type": "text", "text": payload.studentName || payload.studentId, "color": "#111111", "size": "sm", "flex": 4, "wrap": true }] },
                    { "type": "box", "layout": "baseline", "contents": [{ "type": "text", "text": "รหัสบิล", "color": "#888888", "size": "sm", "flex": 2 }, { "type": "text", "text": String(payload.billId), "color": "#111111", "size": "sm", "flex": 4 }] },
                    { "type": "box", "layout": "baseline", "contents": [{ "type": "text", "text": "รายการ", "color": "#888888", "size": "sm", "flex": 2 }, { "type": "text", "text": payload.item || 'ชำระเงิน', "color": "#111111", "size": "sm", "flex": 4, "wrap": true }] },
                    (note ? { "type": "box", "layout": "baseline", "margin": "md", "contents": [{ "type": "text", "text": "หมายเหตุ", "color": "#EF4444", "size": "sm", "flex": 2, "weight": "bold" }, { "type": "text", "text": note, "color": "#EF4444", "size": "sm", "flex": 4, "wrap": true }] } : { "type": "filler" })
                ]
            },
            "footer": { "type": "box", "layout": "vertical", "contents": [{ "type": "button", "action": { "type": "uri", "label": "ตรวจสอบสลิป", "uri": fileUrl }, "style": "primary", "color": headerColor, "height": "sm" }] }
        }
    };
    await sendLineMessage(LINE_ACCESS_TOKEN, LINE_TARGET_ID, [adminFlex]);

    if (payload.studentLineId && payload.studentLineId.length > 5) {
        let studentTitle = "✅ ชำระเงินสำเร็จ";
        let studentIcon = "https://img.icons8.com/fluency/96/ok.png";
        let studentColor = "#06C755";
        let displayStatus = "ชำระแล้ว";
        let descText = `ยอดเงิน ${actualFmt} บาท`;

        if (isUnderpaid) {
            studentTitle = "⚠️ ยอดชำระไม่ครบ"; studentIcon = "https://img.icons8.com/fluency/96/high-importance.png"; studentColor = "#F59E0B"; displayStatus = "ค้างชำระ (นำไปลดยอดบิลแล้ว)"; descText = `ระบบได้รับยอดโอน ${actualFmt} บาท\n(ยอดเต็ม ${formattedTotal} บาท)`;
        } else if (status === 'รอตรวจสอบ' || isOverpaid) {
            studentTitle = "🔄 กำลังตรวจสอบ"; studentIcon = "https://img.icons8.com/fluency/96/hourglass.png"; studentColor = "#F59E0B"; displayStatus = "รอตรวจสอบ"; descText = `ระบบได้รับยอดโอน ${actualFmt} บาท แล้ว แอดมินจะตรวจสอบเร็วๆ นี้`;
        }

        const studentFlex = {
            "type": "flex", "altText": studentTitle,
            "contents": {
                "type": "bubble", "size": "mega",
                "body": {
                    "type": "box", "layout": "vertical", "paddingAll": "20px",
                    "contents": [
                        { "type": "image", "url": studentIcon, "size": "sm", "aspectMode": "fit", "margin": "md" },
                        { "type": "text", "text": studentTitle, "weight": "bold", "size": "xl", "align": "center", "margin": "md", "color": studentColor },
                        { "type": "text", "text": descText, "size": "sm", "align": "center", "margin": "sm", "color": "#111111", "wrap": true },
                        { "type": "separator", "margin": "xl" },
                        { "type": "box", "layout": "vertical", "margin": "lg", "spacing": "sm", "contents": [
                            { "type": "box", "layout": "baseline", "contents": [{ "type": "text", "text": "รหัสบิล", "color": "#888888", "size": "sm", "flex": 1 }, { "type": "text", "text": String(payload.billId), "color": "#111111", "size": "sm", "flex": 2, "align": "end" }] },
                            { "type": "box", "layout": "baseline", "contents": [{ "type": "text", "text": "รายการ", "color": "#888888", "size": "sm", "flex": 1 }, { "type": "text", "text": payload.item || 'ชำระเงิน', "color": "#111111", "size": "sm", "flex": 2, "align": "end", "wrap": true }] },
                            { "type": "box", "layout": "baseline", "contents": [{ "type": "text", "text": "สถานะ", "color": "#888888", "size": "sm", "flex": 1 }, { "type": "text", "text": displayStatus, "color": studentColor, "weight": "bold", "size": "sm", "flex": 2, "align": "end", "wrap": true }] }
                        ]}
                    ]
                }
            }
        };
        await sendLineMessage(STUDENT_LINE_ACCESS_TOKEN, payload.studentLineId, [studentFlex]);
    }
}

async function sendOrderNotification(payload, orderId, fileUrl, actualAmount) {
    const actualFmt = Number(actualAmount).toLocaleString('th-TH', {minimumFractionDigits: 2});
    
    const adminFlex = {
        "type": "flex", "altText": `📦 มีคำสั่งซื้อใหม่: ${orderId}`,
        "contents": {
            "type": "bubble", "size": "mega",
            "header": { "type": "box", "layout": "horizontal", "backgroundColor": "#0066FF", "paddingAll": "15px", "contents": [{ "type": "text", "text": `📦 คำสั่งซื้อใหม่ (${actualFmt} บ.)`, "weight": "bold", "color": "#FFFFFF", "size": "md", "flex": 1 }] },
            "hero": { "type": "image", "url": fileUrl, "size": "full", "aspectRatio": "20:13", "aspectMode": "cover", "action": { "type": "uri", "uri": fileUrl } },
            "body": {
                "type": "box", "layout": "vertical", "paddingAll": "15px", "spacing": "sm",
                "contents": [
                    { "type": "box", "layout": "baseline", "contents": [{ "type": "text", "text": "ผู้สั่ง", "color": "#888888", "size": "sm", "flex": 2 }, { "type": "text", "text": payload.studentName || payload.studentId, "color": "#111111", "size": "sm", "flex": 4, "wrap": true }] },
                    { "type": "box", "layout": "baseline", "contents": [{ "type": "text", "text": "รหัส", "color": "#888888", "size": "sm", "flex": 2 }, { "type": "text", "text": String(orderId), "color": "#111111", "size": "sm", "flex": 4 }] },
                    { "type": "box", "layout": "baseline", "contents": [{ "type": "text", "text": "สินค้า", "color": "#888888", "size": "sm", "flex": 2 }, { "type": "text", "text": `${payload.productName} (${payload.size}) x${payload.quantity}`, "color": "#111111", "size": "sm", "flex": 4, "wrap": true }] }
                ]
            }
        }
    };
    await sendLineMessage(LINE_ACCESS_TOKEN, LINE_TARGET_ID, [adminFlex]);
}

function createRecoveryFlex(student) {
    const safeName = student.name ? String(student.name) : "-";
    const safePass = student.password ? String(student.password) : "ไม่ระบุ"; 
    return {
        "type": "flex", "altText": "🔐 ข้อมูลบัญชีของคุณ",
        "contents": {
            "type": "bubble",
            "body": {
                "type": "box", "layout": "vertical", "contents": [
                    { "type": "text", "text": "ACCOUNT RECOVERY", "weight": "bold", "color": "#1DB446", "size": "xs" },
                    { "type": "text", "text": "ข้อมูลบัญชีของคุณ", "weight": "bold", "size": "xl", "margin": "md" },
                    { "type": "separator", "margin": "xxl" },
                    { "type": "box", "layout": "vertical", "margin": "xxl", "spacing": "sm", "contents": [
                        { "type": "box", "layout": "horizontal", "contents": [{ "type": "text", "text": "ชื่อ", "size": "sm", "color": "#555555", "flex": 0 }, { "type": "text", "text": safeName, "size": "sm", "color": "#111111", "align": "end" }]},
                        { "type": "box", "layout": "horizontal", "contents": [{ "type": "text", "text": "รหัสผ่าน", "size": "sm", "color": "#555555", "flex": 0 }, { "type": "text", "text": safePass, "size": "xl", "color": "#EF4444", "align": "end", "weight": "bold" }]}
                    ]},
                    { "type": "separator", "margin": "xxl" },
                    { "type": "text", "text": "เปลี่ยนรหัสผ่านที่การตั้งค่าภายในเว็บ", "size": "xs", "color": "#aaaaaa", "margin": "lg", "align": "center" }
                ]
            }
        }
    };
}

async function sendLineMessage(token, to, messages) {
    const url = 'https://api.line.me/v2/bot/message/push';
    const cleanMessages = messages.map(msg => (msg.type === 'bubble') ? { type: 'flex', altText: 'Notification', contents: msg } : msg);
    
    try { 
        const response = await axios.post(url, 
            { to: to, messages: cleanMessages },
            { headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token } }
        );
        return { success: response.status === 200, error: null }; 
    } catch (ex) { 
        return { success: false, error: ex.response ? JSON.stringify(ex.response.data) : ex.toString() }; 
    }
}
