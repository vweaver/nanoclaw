import crypto from 'crypto';
import readline from 'readline';

import { ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, RegisteredGroup } from '../types.js';
import { readEnvFile } from '../env.js';

export class TerminalChannel implements Channel {
  name = 'terminal';

  private rl: readline.Interface | null = null;
  private activeJid: string;
  private opts: ChannelOpts;

  constructor(defaultJid: string, opts: ChannelOpts) {
    this.activeJid = defaultJid;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: this.buildPrompt(),
    });

    this.rl.on('line', (line) => {
      const text = line.trim();
      if (!text) {
        this.rl?.prompt();
        return;
      }

      // Terminal commands
      if (text.startsWith('/')) {
        this.handleCommand(text);
        return;
      }

      const timestamp = new Date().toISOString();
      this.opts.onChatMetadata(
        this.activeJid,
        timestamp,
        undefined,
        'terminal',
      );
      this.opts.onMessage(this.activeJid, {
        id: `term-${crypto.randomUUID()}`,
        chat_jid: this.activeJid,
        sender: 'terminal-user',
        sender_name: 'You',
        content: text,
        timestamp,
        is_from_me: true,
      });

      this.rl?.prompt();
    });

    this.rl.on('close', () => {
      logger.info('Terminal input closed');
    });

    const groupName = this.getGroupName(this.activeJid);
    console.log(`\n  Terminal channel active — group: ${groupName} (${this.activeJid})`);
    console.log(`  Commands: /groups, /switch <name>, /help\n`);
    this.rl.prompt();
  }

  private handleCommand(input: string): void {
    const [cmd, ...args] = input.split(/\s+/);

    switch (cmd) {
      case '/groups': {
        const groups = this.opts.registeredGroups();
        const entries = Object.entries(groups);
        if (entries.length === 0) {
          this.printSystem('No registered groups');
          break;
        }
        this.printSystem('Registered groups:');
        for (const [jid, group] of entries) {
          const marker = jid === this.activeJid ? ' <--' : '';
          console.log(`  ${group.name} (${jid})${marker}`);
        }
        break;
      }

      case '/switch': {
        const query = args.join(' ').trim().toLowerCase();
        if (!query) {
          this.printSystem('Usage: /switch <group name or JID>');
          break;
        }
        const groups = this.opts.registeredGroups();
        // Match by name (partial, case-insensitive) or exact JID
        const match = Object.entries(groups).find(
          ([jid, group]) =>
            jid === query ||
            group.name.toLowerCase() === query ||
            group.name.toLowerCase().includes(query) ||
            group.folder.toLowerCase() === query,
        );
        if (!match) {
          this.printSystem(`No group matching "${args.join(' ')}". Use /groups to list.`);
          break;
        }
        const [jid, group] = match;
        this.activeJid = jid;
        this.updatePrompt();
        this.printSystem(`Switched to: ${group.name} (${jid})`);
        break;
      }

      case '/help':
        this.printSystem('Terminal commands:');
        console.log('  /groups          — list all registered groups');
        console.log('  /switch <name>   — switch active group');
        console.log('  /help            — show this help');
        break;

      default:
        this.printSystem(`Unknown command: ${cmd}. Type /help for commands.`);
    }

    this.rl?.prompt();
  }

  private getGroupName(jid: string): string {
    const groups = this.opts.registeredGroups();
    return groups[jid]?.name || jid;
  }

  private buildPrompt(): string {
    const name = this.getGroupName(this.activeJid);
    return `[${name}] You> `;
  }

  private updatePrompt(): void {
    if (this.rl) {
      const prompt = this.buildPrompt();
      this.rl.setPrompt(prompt);
    }
  }

  private printSystem(msg: string): void {
    if (this.rl) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
    }
    console.log(`* ${msg}`);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (jid !== this.activeJid) return; // only show messages for active group
    if (this.rl) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
    }
    const agentName = this.opts.registeredGroups()[jid]?.assistantName || ASSISTANT_NAME;
    console.log(`${agentName}> ${text}`);
    this.rl?.prompt();
  }

  isConnected(): boolean {
    return this.rl !== null;
  }

  ownsJid(jid: string): boolean {
    // Terminal bridges to ALL registered groups so broadcast reaches it
    const groups = this.opts.registeredGroups();
    return jid in groups;
  }

  async disconnect(): Promise<void> {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  /** Display an inbound message from another channel (e.g. Telegram user). */
  displayInbound(jid: string, senderName: string, text: string): void {
    if (jid !== this.activeJid) return; // only show messages for active group
    if (this.rl) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
    }
    console.log(`${senderName}> ${text}`);
    this.rl?.prompt();
  }
}

// Singleton so index.ts can access it for inbound display
let terminalInstance: TerminalChannel | null = null;

export function getTerminalChannel(): TerminalChannel | null {
  return terminalInstance;
}

registerChannel('terminal', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TERMINAL_BRIDGE_JID']);
  const defaultJid =
    process.env.TERMINAL_BRIDGE_JID || envVars.TERMINAL_BRIDGE_JID || '';
  if (!defaultJid) {
    return null;
  }
  terminalInstance = new TerminalChannel(defaultJid, opts);
  return terminalInstance;
});
