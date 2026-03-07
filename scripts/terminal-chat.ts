#!/usr/bin/env npx tsx
/**
 * Terminal chat client for NanoClaw.
 * Connects to a running NanoClaw service via the shared SQLite database.
 *
 * Usage: npx tsx scripts/terminal-chat.ts <group_folder>
 * Example: npx tsx scripts/terminal-chat.ts telegram_main
 */

import crypto from 'crypto';
import fs from 'fs';
import readline from 'readline';

import {
  getAllRegisteredGroups,
  initDatabase,
  storeMessageDirect,
} from '../src/db.js';
import { ASSISTANT_NAME, DATA_DIR, TRIGGER_PATTERN } from '../src/config.js';

// We need a raw query for messages including bot replies,
// since getMessagesSince() filters them out.
import Database from 'better-sqlite3';
import path from 'path';
import { STORE_DIR } from '../src/config.js';

interface Message {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: number;
  is_bot_message: number;
}

const POLL_INTERVAL = 1000;
const CLI_SENDER = 'cli-user';
const CLI_SENDER_NAME = process.env.USER || 'You';
const HISTORY_COUNT = 50;

// ANSI colors
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function getDb(): Database.Database {
  return new Database(path.join(STORE_DIR, 'messages.db'), { readonly: true });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatMessage(msg: Message): string {
  const time = `${DIM}${formatTime(msg.timestamp)}${RESET}`;
  if (msg.is_bot_message) {
    return `${time} ${BOLD}${msg.sender_name}${RESET}: ${msg.content}`;
  }
  if (msg.sender === CLI_SENDER) {
    return `${time} ${GREEN}${CLI_SENDER_NAME}${RESET}: ${msg.content}`;
  }
  return `${time} ${CYAN}${msg.sender_name}${RESET}: ${msg.content}`;
}

function getMessages(
  db: Database.Database,
  chatJid: string,
  sinceTimestamp: string,
  limit?: number,
): Message[] {
  const sql = limit
    ? `SELECT * FROM messages WHERE chat_jid = ? AND timestamp > ?
       ORDER BY timestamp DESC LIMIT ?`
    : `SELECT * FROM messages WHERE chat_jid = ? AND timestamp > ?
       ORDER BY timestamp`;
  const rows = limit
    ? (db.prepare(sql).all(chatJid, sinceTimestamp, limit) as Message[])
    : (db.prepare(sql).all(chatJid, sinceTimestamp) as Message[]);
  return limit ? rows.reverse() : rows;
}

function main() {
  const groupFolder = process.argv[2];
  if (!groupFolder) {
    console.error('Usage: npx tsx scripts/terminal-chat.ts <group_folder>');
    console.error('Example: npx tsx scripts/terminal-chat.ts telegram_main');
    process.exit(1);
  }

  // Init NanoClaw DB (creates schema if needed)
  initDatabase();

  // Find the group by folder name
  const groups = getAllRegisteredGroups();
  const entry = Object.entries(groups).find(([, g]) => g.folder === groupFolder);
  if (!entry) {
    console.error(`Group folder "${groupFolder}" not found.`);
    console.error(
      'Available:',
      Object.values(groups)
        .map((g) => g.folder)
        .join(', ') || '(none)',
    );
    process.exit(1);
  }

  const [chatJid, group] = entry;
  const needsTrigger = !group.isMain && group.requiresTrigger !== false;

  console.log(`${BOLD}NanoClaw Terminal Chat${RESET}`);
  console.log(`Group: ${group.name} (${groupFolder})`);
  console.log(`JID: ${chatJid}`);
  if (needsTrigger) {
    console.log(
      `${DIM}Trigger required — messages auto-prefixed with @${ASSISTANT_NAME}${RESET}`,
    );
  }
  console.log(`${DIM}Type /quit to exit, /history N to show more history${RESET}`);
  console.log('─'.repeat(60));

  // Show recent history
  const readDb = getDb();
  const history = getMessages(readDb, chatJid, '', HISTORY_COUNT);
  for (const msg of history) {
    console.log(formatMessage(msg));
  }
  if (history.length > 0) {
    console.log(`${DIM}─── End of history ───${RESET}`);
  }

  // Track last seen timestamp for polling
  let lastSeen =
    history.length > 0
      ? history[history.length - 1].timestamp
      : new Date().toISOString();

  // Poll for new messages
  const pollTimer = setInterval(() => {
    try {
      const newMsgs = getMessages(readDb, chatJid, lastSeen);
      for (const msg of newMsgs) {
        // Skip messages we just sent from this terminal
        if (msg.sender === CLI_SENDER) {
          lastSeen = msg.timestamp;
          continue;
        }
        console.log(formatMessage(msg));
        lastSeen = msg.timestamp;
      }
    } catch {
      // DB might be briefly locked; retry next cycle
    }
  }, POLL_INTERVAL);

  // Readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${GREEN}> ${RESET}`,
  });

  rl.prompt();

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    // Handle commands
    if (trimmed === '/quit' || trimmed === '/exit') {
      rl.close();
      return;
    }

    if (trimmed.startsWith('/history')) {
      const n = parseInt(trimmed.split(' ')[1]) || 50;
      const msgs = getMessages(readDb, chatJid, '', n);
      for (const msg of msgs) {
        console.log(formatMessage(msg));
      }
      rl.prompt();
      return;
    }

    if (trimmed === '/status') {
      console.log(`${DIM}Group: ${group.name} | JID: ${chatJid} | Folder: ${groupFolder}${RESET}`);
      rl.prompt();
      return;
    }

    // Prepare message content
    let content = trimmed;
    if (needsTrigger && !TRIGGER_PATTERN.test(content)) {
      content = `@${ASSISTANT_NAME} ${content}`;
    }

    // Echo to Telegram via IPC
    const ipcDir = path.join(DATA_DIR, 'ipc', groupFolder, 'messages');
    fs.mkdirSync(ipcDir, { recursive: true });
    fs.writeFileSync(
      path.join(ipcDir, `${crypto.randomUUID()}.json`),
      JSON.stringify({
        type: 'message',
        chatJid,
        text: `${CLI_SENDER_NAME}: ${trimmed}`,
      }),
    );

    // Write to DB — NanoClaw service will pick it up
    storeMessageDirect({
      id: `cli-${crypto.randomUUID()}`,
      chat_jid: chatJid,
      sender: CLI_SENDER,
      sender_name: CLI_SENDER_NAME,
      content,
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });

    // Echo locally
    console.log(
      `${DIM}${formatTime(new Date().toISOString())}${RESET} ${GREEN}${CLI_SENDER_NAME}${RESET}: ${content}`,
    );
    rl.prompt();
  });

  rl.on('close', () => {
    clearInterval(pollTimer);
    readDb.close();
    console.log(`\n${DIM}Disconnected.${RESET}`);
    process.exit(0);
  });
}

main();
