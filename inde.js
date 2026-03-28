const mineflayer = require('mineflayer');
const fetch = require('node-fetch');

const CONFIG = {
  MC_HOST:      process.env.MC_HOST,
  MC_PORT:      parseInt(process.env.MC_PORT) || 25565,
  BOT_USERNAME: process.env.BOT_USERNAME,
  MC_VERSION:   process.env.MC_VERSION || '1.21',
  CHAT_WEBHOOK: process.env.CHAT_WEBHOOK,
  LOG_WEBHOOK:  process.env.LOG_WEBHOOK,
  RECONNECT_DELAY: 10000,
};

let bot = null;
let reconnectTimer = null;

async function sendWebhook(url, content, isEmbed = false) {
  try {
    const body = isEmbed ? { embeds: [content] } : { content };
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error('Webhook送信失敗:', e.message);
  }
}

function logError(title, description) {
  console.error(`[ERROR] ${title}: ${description}`);
  sendWebhook(CONFIG.LOG_WEBHOOK, {
    title: `❌ ${title}`,
    description: `\`\`\`${description}\`\`\``,
    color: 0xff4444,
    timestamp: new Date().toISOString(),
  }, true);
}

function logInfo(title, description) {
  console.log(`[INFO] ${title}: ${description}`);
  sendWebhook(CONFIG.LOG_WEBHOOK, {
    title: `📋 ${title}`,
    description,
    color: 0x44aaff,
    timestamp: new Date().toISOString(),
  }, true);
}

function updatePlayerCount() {
  if (!bot || !bot.players) return;
  const players = Object.keys(bot.players).filter(p => p !== bot.username);
  const count = players.length;
  const list = count > 0 ? players.join(', ') : 'なし';
  logInfo(`🟢 オンライン人数: ${count}人`, `参加中: ${list}`);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  logInfo('再接続待機', `${CONFIG.RECONNECT_DELAY / 1000}秒後に再接続します...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    createBot();
  }, CONFIG.RECONNECT_DELAY);
}

function createBot() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  bot = mineflayer.createBot({
    host: CONFIG.MC_HOST,
    port: CONFIG.MC_PORT,
    username: CONFIG.BOT_USERNAME,
    version: CONFIG.MC_VERSION,
    hideErrors: false,
  });

  bot.once('spawn', () => {
    logInfo('起動', `\`${CONFIG.MC_HOST}\` に接続しました`);
    updatePlayerCount();
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    sendWebhook(CONFIG.CHAT_WEBHOOK, `💬 **${username}**: ${message}`);
  });

  bot.on('playerJoined', (player) => {
    if (player.username === bot.username) return;
    sendWebhook(CONFIG.CHAT_WEBHOOK, ` **${player.username}** が参加しました`);
    updatePlayerCount();
  });

  bot.on('playerLeft', (player) => {
    if (player.username === bot.username) return;
    sendWebhook(CONFIG.CHAT_WEBHOOK, ` **${player.username}** が退出しました`);
    updatePlayerCount();
  });

  bot.on('kicked', (reason) => {
    logError('キックされました', reason);
    scheduleReconnect();
  });

  bot.on('error', (err) => {
    logError('接続エラー', err.message);
    scheduleReconnect();
  });

  bot.on('end', (reason) => {
    logError('切断されました', reason || '原因不明');
    scheduleReconnect();
  });
}

createBot();
