const bedrock = require('bedrock-protocol');
const fetch = require('node-fetch');

const CONFIG = {
  MC_HOST:         process.env.MC_HOST,
  MC_PORT:         parseInt(process.env.MC_PORT) || 19132,
  BOT_USERNAME:    process.env.BOT_USERNAME,
  CHAT_WEBHOOK:    process.env.CHAT_WEBHOOK,
  LOG_WEBHOOK:     process.env.LOG_WEBHOOK,
  RECONNECT_DELAY: 10000,
};

let client = null;
let reconnectTimer = null;
let stopped = false;

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
    description: `\`\`\`${String(description).slice(0, 1000)}\`\`\``,
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

function scheduleReconnect() {
  if (stopped) {
    logInfo('再接続スキップ', '手動停止中のため再接続しません');
    return;
  }
  if (reconnectTimer) return;
  logInfo('再接続待機', `${CONFIG.RECONNECT_DELAY / 1000}秒後に再接続します...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    createBot();
  }, CONFIG.RECONNECT_DELAY);
}

function stopBot() {
  stopped = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (client) { try { client.disconnect(); } catch(e) {} client = null; }
  logInfo('🛑 Bot停止', '手動で停止しました。再開するには `!start` をMCチャットで送信してください');
}

function startBot() {
  stopped = false;
  logInfo('▶️ Bot再開', '手動で再開しました');
  createBot();
}

function handleCommand(username, message) {
  const cmd = message.trim();

  if (cmd === '!stop') {
    logInfo('コマンド受信', `${username} が !stop を実行しました`);
    stopBot();
    return true;
  }
  if (cmd === '!start') {
    if (!stopped) {
      logInfo('コマンド受信', `${username} が !start を実行しましたが、すでに稼働中です`);
      return true;
    }
    logInfo('コマンド受信', `${username} が !start を実行しました`);
    startBot();
    return true;
  }
  if (cmd === '!status') {
    logInfo('ステータス確認', `${username} が確認: ${stopped ? '🛑 停止中' : '🟢 稼働中'}`);
    return true;
  }
  return false;
}

function createBot() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  client = bedrock.createClient({
    host: CONFIG.MC_HOST,
    port: CONFIG.MC_PORT,
    username: CONFIG.BOT_USERNAME,
    offline: true,
  });

  client.on('spawn', () => {
    logInfo('Bot起動', `\`${CONFIG.MC_HOST}:${CONFIG.MC_PORT}\` に接続しました`);
    setTimeout(() => {
      client.queue('command_request', {
        command: '/earth',
        origin: { type: 'player', uuid: '', request_id: '' },
        internal: false,
        version: 52,
      });
      logInfo('/earth 実行', 'スポーン後に /earth を実行しました');
    }, 3000);
  });

  client.on('text', (packet) => {
    // デバッグ：パケット内容をコンソールに出力
    console.log('[TEXT PACKET]', JSON.stringify(packet));

    const type = packet.type;
    const username = packet.source_name || '';
    const message = packet.message || '';

    // BOT自身のメッセージは無視
    if (username === CONFIG.BOT_USERNAME) return;

    // チャット以外（システムメッセージなど）は無視
    if (type !== 'chat') return;

    // コマンド判定
    if (handleCommand(username, message)) return;

    // 通常チャット → Discord
    sendWebhook(CONFIG.CHAT_WEBHOOK, `💬 **${username}**: ${message}`);
  });

  client.on('player_list', (packet) => {
    if (!packet.records || !packet.records.records) return;
    for (const record of packet.records.records) {
      if (!record.username || record.username === CONFIG.BOT_USERNAME) continue;
      if (packet.records.type === 'add') {
        sendWebhook(CONFIG.CHAT_WEBHOOK, `✅ **${record.username}** が参加しました`);
      } else if (packet.records.type === 'remove') {
        sendWebhook(CONFIG.CHAT_WEBHOOK, `🚪 **${record.username}** が退出しました`);
      }
    }
  });

  client.on('kick', (reason) => {
    logError('Botがキックされました', JSON.stringify(reason));
    scheduleReconnect();
  });

  client.on('error', (err) => {
    logError('接続エラー', err.message);
    scheduleReconnect();
  });

  client.on('close', () => {
    logError('切断されました', '接続が閉じられました');
    scheduleReconnect();
  });
}

createBot();
