const bedrock = require('bedrock-protocol');
const fetch = require('node-fetch');
const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits
} = require('discord.js');

const CONFIG = {
  MC_HOST:            process.env.MC_HOST,
  MC_PORT:            parseInt(process.env.MC_PORT) || 19132,
  BOT_USERNAME:       process.env.BOT_USERNAME,
  CHAT_WEBHOOK:       process.env.CHAT_WEBHOOK,
  LOG_WEBHOOK:        process.env.LOG_WEBHOOK,
  DISCORD_TOKEN:      process.env.DISCORD_TOKEN,
  DISCORD_CLIENT_ID:  process.env.DISCORD_CLIENT_ID,
  CHAT_CHANNEL_ID:    process.env.CHAT_CHANNEL_ID,
  RECONNECT_DELAY:    10000,
};

let mcClient     = null;
let reconnectTimer = null;
let stopped      = false;
let afkTimer     = null;
let spawned      = false;
let discordClient = null;

// サーバー状態
const serverState = {
  onlinePlayers: [],
  ping: null,
  gameTime: null,
  connectedAt: null,
};

// ===== Webhook =====
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
    title: ` ${title}`,
    description,
    color: 0x44aaff,
    timestamp: new Date().toISOString(),
  }, true);
}

// ===== ゲーム内時刻変換 =====
function ticksToTimeString(ticks) {
  const normalizedTicks = ((ticks % 24000) + 24000) % 24000;
  const totalMinutes = Math.floor((normalizedTicks / 24000) * 24 * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

// ===== Ping計測 =====
async function measurePing() {
  try {
    const start = Date.now();
    await bedrock.ping({ host: CONFIG.MC_HOST, port: CONFIG.MC_PORT });
    serverState.ping = Date.now() - start;
  } catch (e) {
    serverState.ping = null;
  }
}

// ===== チャンネルトピック更新 =====
async function updateChannelTopic() {
  if (!discordClient || !CONFIG.CHAT_CHANNEL_ID) return;
  try {
    const channel = await discordClient.channels.fetch(CONFIG.CHAT_CHANNEL_ID);
    if (!channel) return;

    const playerList = serverState.onlinePlayers.length > 0
      ? serverState.onlinePlayers.join(', ')
      : 'なし';
    const pingText = serverState.ping !== null ? `${serverState.ping}ms` : '不明';
    const timeText = serverState.gameTime !== null
      ? ticksToTimeString(serverState.gameTime)
      : '不明';

    const topic = `🟢 オンライン: ${serverState.onlinePlayers.length}人 | 🏓 Ping: ${pingText} | 🕐 ゲーム内時刻: ${timeText} | 👥 ${playerList}`;
    await channel.setTopic(topic);
  } catch (e) {
    console.error('[Topic更新失敗]', e.message);
  }
}

// ===== サーバーステータス取得 =====
function buildStatusEmbed() {
  const playerList = serverState.onlinePlayers.length > 0
    ? serverState.onlinePlayers.map(p => `• ${p}`).join('\n')
    : 'なし';
  const pingText = serverState.ping !== null ? `${serverState.ping}ms` : '不明';
  const timeText = serverState.gameTime !== null
    ? ticksToTimeString(serverState.gameTime)
    : '不明';
  const statusText = stopped ? '🛑 Bot停止中' : '🟢 稼働中';

  return {
    title: '📊 サーバーステータス',
    color: stopped ? 0xff4444 : 0x44ff88,
    fields: [
      { name: '状態', value: statusText, inline: true },
      { name: 'Ping', value: pingText, inline: true },
      { name: 'ゲーム内時刻', value: timeText, inline: true },
      { name: `オンライン人数 (${serverState.onlinePlayers.length}人)`, value: playerList },
    ],
    timestamp: new Date().toISOString(),
  };
}

// ===== AFK防止 =====
function doAfkAction() {
  if (!mcClient || !spawned) return;
  const actions = ['right', 'left', 'jump'];
  const action = actions[Math.floor(Math.random() * actions.length)];

  try {
    const baseInput = {
      pitch: 0, yaw: 0,
      position: { x: 0, y: 0, z: 0 },
      move: { x: 0, y: 0 },
      head_yaw: 0,
      input_data: {},
      input_mode: 'mouse',
      play_mode: 'screen',
      interaction_model: 'crosshair',
      gaze_direction: { x: 0, y: 0, z: 0 },
      tick: BigInt(0),
      delta: { x: 0, y: 0, z: 0 },
      item_stack_request: { request_id: 0, actions: [], two_item_types_with_net_ids: [] },
      block_actions: { actions: [] },
      analog_move_vector: { x: 0, y: 0 },
    };

    if (action === 'jump') {
      let count = 0;
      const iv = setInterval(() => {
        if (!mcClient || !spawned) { clearInterval(iv); return; }
        mcClient.queue('player_auth_input', { ...baseInput, input_data: { jumping: true } });
        if (++count >= 3) clearInterval(iv);
      }, 500);

    } else if (action === 'right') {
      mcClient.queue('player_auth_input', { ...baseInput, yaw: 90, head_yaw: 90, analog_move_vector: { x: 1, y: 0 } });
      setTimeout(() => {
        if (!mcClient || !spawned) return;
        mcClient.queue('player_auth_input', { ...baseInput, yaw: 270, head_yaw: 270, analog_move_vector: { x: -1, y: 0 } });
      }, 1000);

    } else if (action === 'left') {
      mcClient.queue('player_auth_input', { ...baseInput, yaw: 270, head_yaw: 270, analog_move_vector: { x: -1, y: 0 } });
      setTimeout(() => {
        if (!mcClient || !spawned) return;
        mcClient.queue('player_auth_input', { ...baseInput, yaw: 90, head_yaw: 90, analog_move_vector: { x: 1, y: 0 } });
      }, 2000);
    }

    console.log(`[AFK] アクション: ${action}`);
  } catch (e) {
    console.error('[AFK] エラー:', e.message);
  }
}

function startAfkLoop() {
  stopAfkLoop();
  afkTimer = setInterval(doAfkAction, 3 * 60 * 1000);
}

function stopAfkLoop() {
  if (afkTimer) { clearInterval(afkTimer); afkTimer = null; }
}

// ===== 定期ステータス更新（1分ごと）=====
setInterval(async () => {
  if (!stopped) {
    await measurePing();
    await updateChannelTopic();
  }
}, 60 * 1000);

// ===== MC Bot 停止・再開 =====
function scheduleReconnect() {
  if (stopped) { logInfo('再接続スキップ', '手動停止中のため再接続しません'); return; }
  if (reconnectTimer) return;
  logInfo('再接続待機', `${CONFIG.RECONNECT_DELAY / 1000}秒後に再接続します...`);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; createBot(); }, CONFIG.RECONNECT_DELAY);
}

function stopBot() {
  stopped = true;
  spawned = false;
  serverState.onlinePlayers = [];
  stopAfkLoop();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (mcClient) { try { mcClient.disconnect(); } catch(e) {} mcClient = null; }
  logInfo('🛑 Bot停止', 'Discordの `/start` で再開できます');
  updateChannelTopic();
}

function startBot() {
  stopped = false;
  logInfo('▶️ Bot再開', '手動で再開しました');
  createBot();
}

// ===== MC Bot 作成 =====
function createBot() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  mcClient = bedrock.createClient({
    host: CONFIG.MC_HOST,
    port: CONFIG.MC_PORT,
    username: CONFIG.BOT_USERNAME,
    offline: true,
  });

  mcClient.on('spawn', async () => {
    spawned = true;
    serverState.connectedAt = new Date();
    logInfo('MC起動', `\`${CONFIG.MC_HOST}:${CONFIG.MC_PORT}\` に接続しました`);

    // /earth コマンド
    setTimeout(() => {
      try {
        mcClient.queue('command_request', {
          command: '/earth',
          origin: { type: 'player', uuid: '', request_id: '' },
          internal: false,
          version: 52,
        });
        logInfo('/earth 実行', 'スポーン後に /earth を実行しました');
      } catch(e) {}
    }, 3000);

    await measurePing();
    await updateChannelTopic();
    startAfkLoop();
  });

  // チャット受信（MC→Discord のみ、Discord→MCは不可）
  mcClient.on('text', (packet) => {
    console.log('[TEXT PACKET]', JSON.stringify(packet));
    if (packet.type !== 'chat') return;
    const username = packet.source_name || '';
    const message  = packet.message  || '';
    if (username === CONFIG.BOT_USERNAME) return;
    sendWebhook(CONFIG.CHAT_WEBHOOK, `💬 **${username}**: ${message}`);
  });

  // ゲーム内時刻取得
  mcClient.on('set_time', (packet) => {
    serverState.gameTime = packet.time;
  });

  // プレイヤー一覧
  mcClient.on('player_list', async (packet) => {
    if (!packet.records || !packet.records.records) return;
    for (const record of packet.records.records) {
      if (!record.username || record.username === CONFIG.BOT_USERNAME) continue;
      if (packet.records.type === 'add') {
        if (!serverState.onlinePlayers.includes(record.username)) {
          serverState.onlinePlayers.push(record.username);
        }
        sendWebhook(CONFIG.CHAT_WEBHOOK, `✅ **${record.username}** が参加しました`);
      } else if (packet.records.type === 'remove') {
        serverState.onlinePlayers = serverState.onlinePlayers.filter(p => p !== record.username);
        sendWebhook(CONFIG.CHAT_WEBHOOK, `🚪 **${record.username}** が退出しました`);
      }
    }
    await updateChannelTopic();
  });

  mcClient.on('kick', (reason) => {
    spawned = false; stopAfkLoop();
    logError('Botがキックされました', JSON.stringify(reason));
    scheduleReconnect();
  });

  mcClient.on('error', (err) => {
    spawned = false; stopAfkLoop();
    logError('接続エラー', err.message);
    scheduleReconnect();
  });

  mcClient.on('close', () => {
    spawned = false; stopAfkLoop();
    logError('切断されました', '接続が閉じられました');
    scheduleReconnect();
  });
}

// ===== Discord Bot =====
async function setupDiscord() {
  const commands = [
    // 誰でも実行可能
    new SlashCommandBuilder()
      .setName('serverstatus')
      .setDescription('サーバーの現在の状況を表示する')
      .setDefaultMemberPermissions(null), // 制限なし

    // 管理者のみ
    new SlashCommandBuilder()
      .setName('stop')
      .setDescription('MCボットを停止する')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName('start')
      .setDescription('MCボットを再開する')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName('status')
      .setDescription('MCボットの稼働状態を確認する')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CONFIG.DISCORD_CLIENT_ID), { body: commands });
    console.log('[Discord] スラッシュコマンド登録完了');
  } catch (e) {
    console.error('[Discord] コマンド登録失敗:', e.message);
  }

  discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });

  discordClient.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'serverstatus') {
      await measurePing();
      await interaction.reply({ embeds: [buildStatusEmbed()] });
      return;
    }

    if (interaction.commandName === 'stop') {
      if (!stopped) {
        stopBot();
        await interaction.reply({ content: '🛑 MCボットを停止しました', ephemeral: true });
      } else {
        await interaction.reply({ content: '⚠️ すでに停止中です', ephemeral: true });
      }
      return;
    }

    if (interaction.commandName === 'start') {
      if (stopped) {
        startBot();
        await interaction.reply({ content: '▶️ MCボットを再開しました', ephemeral: true });
      } else {
        await interaction.reply({ content: '⚠️ すでに稼働中です', ephemeral: true });
      }
      return;
    }

    if (interaction.commandName === 'status') {
      const status = stopped ? '🛑 停止中' : '🟢 稼働中';
      await interaction.reply({ content: `現在の状態: **${status}**`, ephemeral: true });
      return;
    }
  });

  discordClient.once('ready', () => {
    console.log(`[Discord] ${discordClient.user.tag} でログインしました`);
  });

  await discordClient.login(CONFIG.DISCORD_TOKEN);
}

// ===== 起動 =====
setupDiscord().catch(e => logError('Discord起動失敗', e.message));
createBot();
