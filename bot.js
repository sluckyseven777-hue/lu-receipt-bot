
/******************************************************************
 * LU RECEIPT BOT V1.0 STABLE VERIFY
 * Based on XC V1.3
 *
 * +amount -> ADD
 * +0      -> SUMMARY
 * reply void -> VOID
 *
 * ADD never automatically retries.
 ******************************************************************/

const http = require('http');

const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder
} = require('discord.js');

const TOKEN = process.env.TOKEN;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

const VERSION = 'LU RECEIPT BOT V1.0 STABLE VERIFY';
const COMPANY = 'LU';
const CHANNEL_ID = '1536955756174377062';

const VOID_WORDS = new Set([
  'void', 'cancel', '撤销', '撤銷'
]);

const MAX_SUMMARY_ENTRIES = 25;

if (!TOKEN || !APPS_SCRIPT_URL) {
  throw new Error('Missing TOKEN or APPS_SCRIPT_URL');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Render Web Service health server
http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8'
  });
  res.end(VERSION + ' running');
}).listen(process.env.PORT || 10000, '0.0.0.0');

client.once(Events.ClientReady, ready => {
  console.log('[READY]', ready.user.tag);
  console.log('[CHANNEL]', CHANNEL_ID);
});

// Avoid processing the same Discord event concurrently
const processing = new Set();

client.on(Events.MessageCreate, async message => {

  if (message.author.bot || message.webhookId) return;
  if (message.channel.id !== CHANNEL_ID) return;

  const content = String(message.content || '').trim();
  if (!content) return;

  if (processing.has(message.id)) return;
  processing.add(message.id);

  try {

    // VOID
    if (VOID_WORDS.has(content.toLowerCase())) {
      await handleVoid(message);
      return;
    }

    // SUMMARY: +0 or +0.00
    if (/^\+\s*0(?:\.0{1,2})?$/.test(content)) {
      await handleSummary(message);
      return;
    }

    // ADD
    const amount = parseAmount(content);
    if (amount === null) return;

    await handleReceipt(message, amount);

  } catch (err) {
    console.error('[MESSAGE ERROR]', err);
  } finally {
    processing.delete(message.id);
  }

});

/******************************************************************
 * ADD RECEIPT
 ******************************************************************/

async function handleReceipt(message, amount) {

  const reporter = getDisplayName(message);
  const messageId = message.id;

  let addResult = null;
  let responseFailed = false;

  // Critical: ADD is sent once only.
  try {

    addResult = await callAppsScript({
      action: 'ADD',
      company: COMPANY,
      amount,
      reporter,
      discordId: message.author.id,
      messageId
    });

  } catch (err) {

    responseFailed = true;
    console.error('[ADD RESPONSE FAILED]', messageId, err);

  }

  // Apps Script explicitly rejected this ADD.
  if (!responseFailed && (!addResult || !addResult.ok)) {

    if (
      addResult &&
      addResult.error === 'OUTSIDE_BUSINESS_HOURS'
    ) {

      await safeReply(message, [
        '⏰ **LU 報賬時間已結束**',
        '',
        '**營業時間：07:00–19:00（Malaysia Time）**',
        '',
        '此筆金額沒有入賬。',
        '請在下一個營業日早上 07:00 後重新報賬。'
      ].join('\n'));

      return;
    }

    await safeReply(message, [
      '⚠️ **Receipt Failed | 報賬失敗**',
      '',
      `Amount | 金額：${formatAmount(amount)}`,
      `Error: ${addResult?.error || 'UNKNOWN'}`,
      '',
      '請管理員檢查 LU Google Sheet。'
    ].join('\n'));

    return;
  }

  // Same Message ID is already in Sheet.
  if (!responseFailed && addResult.duplicate) {
    console.log('[DUPLICATE]', messageId);
    return;
  }

  const summary = await getSummaryWithRetry(3);

  // Explicit ADD success.
  if (!responseFailed && addResult.ok) {

    if (summary?.ok) {
      await sendEmbed(message, {
        type: 'ADD',
        amount,
        reporter,
        summary
      });
    } else {
      await safeReply(message, [
        `✅ **已確認入款：${formatAmount(amount)}**`,
        `👤 報數人：${reporter}`,
        '',
        '入款已記錄成功。',
        '⚠️ 今日統計暫時無法載入。'
      ].join('\n'));
    }

    return;
  }

  // HTTP failure does NOT imply that ADD failed.
  // Never send ADD again.
  if (responseFailed) {

    if (summary?.ok) {

      const found = findMessageInSummary(
        summary,
        messageId
      );

      if (found) {

        await sendEmbed(message, {
          type: 'ADD',
          amount: Number(found.amount),
          reporter,
          summary
        });

        console.log('[ADD VERIFIED]', messageId);
        return;
      }

      await safeReply(message, [
        '⚠️ **Receipt Not Confirmed | 入款未確認**',
        '',
        `Amount：${formatAmount(amount)}`,
        '',
        '今日統計未找到這筆 Message ID。',
        '請管理員檢查 LU Sheet。',
        '**確認前不要重新報數。**'
      ].join('\n'));

      return;
    }

    await safeReply(message, [
      '⏳ **Receipt Pending Verification**',
      '',
      `Amount：${formatAmount(amount)}`,
      '',
      '暫時無法確認 Google Sheet 的寫入狀態。',
      '**請勿重複提交這筆金額。**',
      '請管理員先檢查 LU Sheet。'
    ].join('\n'));
  }

}

/******************************************************************
 * +0 SUMMARY
 ******************************************************************/

async function handleSummary(message) {

  const summary = await getSummaryWithRetry(3);

  if (!summary?.ok) {
    await safeReply(
      message,
      '⚠️ LU 今日統計暫時無法載入，請稍後再試。'
    );
    return;
  }

  await sendEmbed(message, {
    type: 'SUMMARY',
    amount: 0,
    reporter: getDisplayName(message),
    summary
  });

}

/******************************************************************
 * VOID
 ******************************************************************/

async function handleVoid(message) {

  if (!message.reference?.messageId) {

    await safeReply(message,
      '⚠️ 請 Reply 要撤銷的原始報賬訊息，再輸入 `void`。'
    );

    return;
  }

  const targetMessageId = message.reference.messageId;
  let originalMessageId = targetMessageId;

  try {

    const targetMessage =
      await message.channel.messages.fetch(targetMessageId);

    // When replying to the bot confirmation,
    // resolve its referenced original receipt message.
    if (
      targetMessage.author.id === client.user.id &&
      targetMessage.reference?.messageId
    ) {
      originalMessageId = targetMessage.reference.messageId;
    }

  } catch (err) {
    console.log('[VOID FETCH FAILED]', err.message);
  }

  const voidedBy = getDisplayName(message);

  let result;

  try {

    result = await callAppsScript({
      action: 'VOID',
      company: COMPANY,
      targetMessageId: originalMessageId,
      voidMessageId: message.id,
      voidedBy
    });

  } catch (err) {

    await safeReply(message, [
      '⏳ **Void Pending Verification | 撤銷待確認**',
      '',
      '目前無法確認撤銷狀態。',
      '**請勿重複撤銷。**',
      '請管理員檢查 LU Sheet 的 Status。'
    ].join('\n'));

    return;
  }

  if (!result?.ok) {

    await safeReply(message,
      result?.error === 'NOT_FOUND'
        ? '❌ 找不到這筆 LU 入款記錄。'
        : `⚠️ 撤銷失敗：${result?.error || 'UNKNOWN'}`
    );

    return;
  }

  if (result.alreadyVoided) {

    await safeReply(message,
      `⚠️ 這筆 ${formatAmount(result.amount)} 已經撤銷。`
    );

    return;
  }

  const summary = await getSummaryWithRetry(3);

  if (!summary?.ok) {

    await safeReply(message, [
      `♻️ **已撤銷入款：${formatAmount(result.amount)}**`,
      '',
      '撤銷已記錄成功。',
      '⚠️ 今日統計暫時無法載入。'
    ].join('\n'));

    return;
  }

  await sendEmbed(message, {
    type: 'VOID',
    amount: Number(result.amount),
    reporter: voidedBy,
    summary
  });

}

/******************************************************************
 * SUMMARY RETRY
 * Read only. Never repeats ADD.
 ******************************************************************/

async function getSummaryWithRetry(maxAttempts = 3) {

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {

    try {

      const result = await callAppsScript({
        action: 'SUMMARY',
        company: COMPANY
      });

      if (result?.ok) return result;

      console.error('[SUMMARY INVALID]', attempt, result);

    } catch (err) {

      console.error('[SUMMARY FAILED]', attempt, err.message);

    }

    if (attempt < maxAttempts) {
      await sleep(attempt * 1000);
    }
  }

  return null;
}

function findMessageInSummary(summary, messageId) {

  if (!Array.isArray(summary?.entries)) return null;

  return summary.entries.find(
    entry => String(entry.messageId) === String(messageId)
  ) || null;

}

/******************************************************************
 * DISCORD EMBED
 ******************************************************************/

async function sendEmbed(message, {
  type,
  amount,
  reporter,
  summary
}) {

  try {

    const entries = Array.isArray(summary.entries)
      ? summary.entries
      : [];

    const hidden = Math.max(
      0, entries.length - MAX_SUMMARY_ENTRIES
    );

    const visible = entries.slice(-MAX_SUMMARY_ENTRIES);

    const lines = visible.map(entry =>
      `${entry.time || '-'} ${formatAmount(entry.amount)} (${entry.reporter || 'User'})`
    );

    if (!lines.length) {
      lines.push('No active receipts | 暫無有效入款');
    }

    if (hidden) {
      lines.unshift(`… ${hidden} earlier receipts not shown`);
    }

    let title;

    if (type === 'VOID') {
      title = `♻️ 已撤銷入款：${formatAmount(amount)} | Receipt Voided`;
    } else if (type === 'SUMMARY') {
      title = '📊 LU 今日入款統計 | Daily Summary';
    } else {
      title = `✅ 已確認入款：${formatAmount(amount)} | Receipt Confirmed`;
    }

    const who = type === 'VOID'
      ? 'Voided By | 撤銷人'
      : 'Reporter | 報數人';

    const header = type === 'SUMMARY'
      ? ''
      : `**${who}：** ${reporter}\n\n`;

    const description = [
      header,
      `💹 **Today's Receipts | 今日入款（${Number(summary.count || 0)}筆）**`,
      lines.join('\n'),
      '',
      `**Total | 總入款：${formatAmount(summary.totalAmount)}**`,
      `**Business Date | 工作日：${summary.businessDate || '-'}**`
    ].join('\n');

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description.slice(0, 4000))
      .setFooter({ text: 'LU • RECEIPT SYSTEM' })
      .setTimestamp();

    await message.reply({
      embeds: [embed],
      allowedMentions: { repliedUser: false }
    });

  } catch (err) {

    console.error('[EMBED FAILED]', err);

    await safeReply(message, [
      type === 'VOID'
        ? `♻️ 已撤銷：${formatAmount(amount)}`
        : type === 'SUMMARY'
          ? '📊 LU 今日統計'
          : `✅ 已確認入款：${formatAmount(amount)}`,
      `總入款：${formatAmount(summary.totalAmount)}`,
      `工作日：${summary.businessDate || '-'}`
    ].join('\n'));

  }

}

/******************************************************************
 * APPS SCRIPT REQUEST
 ******************************************************************/

async function callAppsScript(payload) {

  if (
    !APPS_SCRIPT_URL.startsWith(
      'https://script.google.com/macros/s/'
    ) ||
    !APPS_SCRIPT_URL.endsWith('/exec')
  ) {
    throw new Error('Invalid APPS_SCRIPT_URL');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {

    const response = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
        'Accept': 'application/json,text/plain,*/*'
      },
      body: JSON.stringify(payload),
      redirect: 'follow',
      signal: controller.signal
    });

    const raw = await response.text();

    if (!response.ok) {
      throw new Error(`Apps Script HTTP ${response.status}`);
    }

    const trimmed = raw.trim();

    if (
      trimmed.startsWith('<!DOCTYPE') ||
      trimmed.toLowerCase().startsWith('<html')
    ) {
      throw new Error('Apps Script returned HTML');
    }

    return JSON.parse(trimmed);

  } catch (err) {

    if (err.name === 'AbortError') {
      throw new Error('Apps Script request timed out');
    }

    throw err;

  } finally {

    clearTimeout(timeout);

  }

}

/******************************************************************
 * HELPERS
 ******************************************************************/

function parseAmount(content) {

  const text = String(content || '').trim();

  if (!text.startsWith('+')) return null;

  const value = text.slice(1).trim();

  const regex = /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/;

  if (!regex.test(value)) return null;

  const amount = Number(value.replace(/,/g, ''));

  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > 999999999.99
  ) {
    return null;
  }

  return Math.round(amount * 100) / 100;
}

function formatAmount(amount) {

  return Number(amount || 0).toLocaleString('en-MY', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function getDisplayName(message) {

  return (
    message.member?.displayName ||
    message.author?.globalName ||
    message.author?.username ||
    'User'
  );
}

async function safeReply(message, content) {

  try {

    await message.reply({
      content,
      allowedMentions: { repliedUser: false }
    });

  } catch (err) {

    console.error('[REPLY FAILED]', err);

  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

process.on('unhandledRejection', err => {
  console.error('[UNHANDLED REJECTION]', err);
});

process.on('uncaughtException', err => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});

client.login(TOKEN);
