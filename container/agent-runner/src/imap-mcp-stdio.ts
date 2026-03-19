/**
 * Read-only IMAP MCP Server for NanoClaw
 * Provides email reading access via IMAP. No send/modify/delete capabilities.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ImapFlow } from 'imapflow';

const IMAP_HOST = process.env.IMAP_HOST!;
const IMAP_USER = process.env.IMAP_USER!;
const IMAP_PASSWORD = process.env.IMAP_PASSWORD!;
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993', 10);

async function withClient<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASSWORD },
    logger: false,
    socketTimeout: 30000,
    greetingTimeout: 15000,
  } as any);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try { await client.logout(); } catch { /* ignore logout errors */ }
  }
}

/** Decode email addresses from parsed header. */
function formatAddress(addr: any): string {
  if (!addr) return '';
  if (Array.isArray(addr)) {
    return addr.map(formatAddress).join(', ');
  }
  if (addr.name && addr.address) return `${addr.name} <${addr.address}>`;
  if (addr.address) return addr.address;
  if (typeof addr === 'string') return addr;
  return JSON.stringify(addr);
}

// --- MCP Server ---

const server = new McpServer({
  name: 'email',
  version: '1.0.0',
});

server.tool(
  'email_list_folders',
  'List all email folders/mailboxes (e.g., INBOX, Sent, Drafts)',
  {},
  async () => {
    try {
      const folders = await withClient(async (client) => {
        const result: Array<{ path: string; name: string; total?: number }> = [];
        const tree = await client.list();
        for (const folder of tree) {
          result.push({
            path: folder.path,
            name: folder.name,
            total: folder.status?.messages,
          });
        }
        return result;
      });

      if (folders.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No folders found.' }],
        };
      }

      const text = folders
        .map((f) => {
          const count = f.total !== undefined ? ` (${f.total} messages)` : '';
          return `• ${f.path}${count}`;
        })
        .join('\n');

      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'email_list_messages',
  'List recent emails in a folder. Returns subject, from, date, and UID for each message. Use UID with email_read_message to get full content.',
  {
    folder: z
      .string()
      .optional()
      .describe('Folder path (default: INBOX)'),
    limit: z
      .number()
      .optional()
      .describe('Number of messages to return (default 20, max 50)'),
    search_from: z
      .string()
      .optional()
      .describe('Filter by sender email/name'),
    search_subject: z
      .string()
      .optional()
      .describe('Filter by subject text'),
    search_since: z
      .string()
      .optional()
      .describe('Only messages since this date (YYYY-MM-DD)'),
    unseen_only: z
      .boolean()
      .optional()
      .describe('Only show unread messages'),
  },
  async ({ folder, limit, search_from, search_subject, search_since, unseen_only }) => {
    try {
      const maxMessages = Math.min(limit || 20, 50);
      const folderPath = folder || 'INBOX';

      const messages = await withClient(async (client) => {
        const lock = await client.getMailboxLock(folderPath);
        try {
          // Build search query
          const searchCriteria: any = {};
          if (search_from) searchCriteria.from = search_from;
          if (search_subject) searchCriteria.subject = search_subject;
          if (search_since) searchCriteria.since = new Date(search_since);
          if (unseen_only) searchCriteria.seen = false;

          const hasSearch = Object.keys(searchCriteria).length > 0;

          const result: Array<{
            uid: number;
            subject: string;
            from: string;
            date: string;
            seen: boolean;
          }> = [];

          if (hasSearch) {
            const searchResult = await client.search(searchCriteria, { uid: true });
            const uids = Array.isArray(searchResult) ? searchResult : [];
            if (uids.length === 0) return result;

            // Take the most recent ones
            const recentUids = uids.slice(-maxMessages);
            for await (const msg of client.fetch(recentUids, {
              envelope: true,
              flags: true,
              uid: true,
            })) {
              result.push({
                uid: msg.uid,
                subject: msg.envelope?.subject || '(no subject)',
                from: formatAddress(msg.envelope?.from),
                date: msg.envelope?.date?.toISOString() || '',
                seen: msg.flags?.has('\\Seen') || false,
              });
            }
          } else {
            // Fetch most recent messages by sequence number
            const total = (client.mailbox as any)?.exists || 0;
            if (total === 0) return result;

            const startSeq = Math.max(1, total - maxMessages + 1);
            for await (const msg of client.fetch(`${startSeq}:*`, {
              envelope: true,
              flags: true,
              uid: true,
            })) {
              result.push({
                uid: msg.uid,
                subject: msg.envelope?.subject || '(no subject)',
                from: formatAddress(msg.envelope?.from),
                date: msg.envelope?.date?.toISOString() || '',
                seen: msg.flags?.has('\\Seen') || false,
              });
            }
          }

          // Sort newest first
          result.sort(
            (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
          );
          return result.slice(0, maxMessages);
        } finally {
          lock.release();
        }
      });

      if (messages.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No messages found.' },
          ],
        };
      }

      const text = messages
        .map((m) => {
          const read = m.seen ? '' : ' 🔵';
          const date = m.date
            ? new Date(m.date).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })
            : '';
          return `${read} UID:${m.uid} | ${date}\n  From: ${m.from}\n  Subject: ${m.subject}`;
        })
        .join('\n\n');

      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'email_read_message',
  'Read the full content of an email by UID. Returns headers and body text.',
  {
    folder: z
      .string()
      .optional()
      .describe('Folder path (default: INBOX)'),
    uid: z.number().describe('Message UID from email_list_messages'),
  },
  async ({ folder, uid }) => {
    try {
      const folderPath = folder || 'INBOX';

      const message = await withClient(async (client) => {
        const lock = await client.getMailboxLock(folderPath);
        try {
          // Step 1: Fetch envelope and body structure
          let envelope: any = null;
          let bodyStructure: any = null;
          for await (const msg of client.fetch([uid], {
            envelope: true,
            bodyStructure: true,
            uid: true,
          })) {
            envelope = msg.envelope;
            bodyStructure = msg.bodyStructure;
          }

          if (!envelope) return null;

          // Step 2: Download body (separate from fetch to avoid nested IMAP commands)
          let body = '';
          try {
            const textPart = await client.download(String(uid), undefined, {
              uid: true,
            });
            if (textPart?.content) {
              const chunks: Buffer[] = [];
              for await (const chunk of textPart.content) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              }
              const raw = Buffer.concat(chunks).toString('utf-8');
              if (raw.includes('<html') || raw.includes('<body')) {
                body = raw
                  .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                  .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                  .replace(/<[^>]+>/g, ' ')
                  .replace(/&nbsp;/g, ' ')
                  .replace(/&amp;/g, '&')
                  .replace(/&lt;/g, '<')
                  .replace(/&gt;/g, '>')
                  .replace(/&quot;/g, '"')
                  .replace(/\s+/g, ' ')
                  .trim();
              } else {
                body = raw;
              }
            }
          } catch {
            body = '(could not download body)';
          }

          // Step 3: List attachments from body structure with part numbers
          const attachments: Array<{ name: string; part: string; size?: number; type?: string }> = [];
          const walkParts = (part: any, path: string = '') => {
            const partNum = part.part || path;
            if (
              (part.disposition === 'attachment' || part.disposition === 'inline') &&
              (part.parameters?.name || part.dispositionParameters?.filename)
            ) {
              attachments.push({
                name: part.parameters?.name || part.dispositionParameters?.filename || 'unnamed',
                part: partNum,
                size: part.size,
                type: part.type ? `${part.type}/${part.subtype || ''}` : undefined,
              });
            }
            if (part.childNodes) {
              for (let i = 0; i < part.childNodes.length; i++) {
                walkParts(part.childNodes[i], part.childNodes[i].part || `${partNum ? partNum + '.' : ''}${i + 1}`);
              }
            }
          };
          if (bodyStructure) walkParts(bodyStructure);

          return {
            subject: envelope?.subject || '(no subject)',
            from: formatAddress(envelope?.from),
            to: formatAddress(envelope?.to),
            cc: formatAddress(envelope?.cc),
            date: envelope?.date?.toISOString() || '',
            body: body.slice(0, 10000),
            attachments,
          };
        } finally {
          lock.release();
        }
      });

      if (!message) {
        return {
          content: [
            { type: 'text' as const, text: `Message UID ${uid} not found.` },
          ],
          isError: true,
        };
      }

      const parts = [
        `Subject: ${message.subject}`,
        `From: ${message.from}`,
        `To: ${message.to}`,
      ];
      if (message.cc) parts.push(`CC: ${message.cc}`);
      parts.push(`Date: ${message.date}`);
      if (message.attachments.length > 0) {
        parts.push('Attachments:');
        for (const a of message.attachments) {
          const size = a.size ? ` (${Math.round(a.size / 1024)}KB)` : '';
          const type = a.type ? ` [${a.type}]` : '';
          parts.push(`  • ${a.name}${size}${type} — part: ${a.part}`);
        }
      }
      parts.push('', '---', '', message.body);

      return {
        content: [{ type: 'text' as const, text: parts.join('\n') }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'email_count_unread',
  'Get the count of unread messages in a folder',
  {
    folder: z
      .string()
      .optional()
      .describe('Folder path (default: INBOX)'),
  },
  async ({ folder }) => {
    try {
      const folderPath = folder || 'INBOX';

      const count = await withClient(async (client) => {
        const lock = await client.getMailboxLock(folderPath);
        try {
          const searchResult = await client.search({ seen: false }, { uid: true });
          const uids = Array.isArray(searchResult) ? searchResult : [];
          return uids.length;
        } finally {
          lock.release();
        }
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: `${count} unread message${count === 1 ? '' : 's'} in ${folderPath}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'email_download_attachment',
  'Download an email attachment and save it to /workspace/group/. Use email_read_message first to get the part number. Returns the saved file path.',
  {
    folder: z.string().default('INBOX').describe('Folder path (default: INBOX)'),
    uid: z.number().describe('Message UID'),
    part: z.string().describe('MIME part number from email_read_message attachment listing'),
    filename: z.string().default('').describe('Override filename (empty = uses original name from email)'),
  },
  async (params) => {
    try {
      const folderPath = params.folder || 'INBOX';
      const uid = params.uid;
      const part = params.part;
      const filename = params.filename;

      const result = await withClient(async (client) => {
        const lock = await client.getMailboxLock(folderPath);
        try {
          // Get the attachment name from body structure if filename not provided
          let attachName = filename || 'attachment';
          if (!filename) {
            for await (const msg of client.fetch([uid], {
              bodyStructure: true,
              uid: true,
            })) {
              const findPart = (p: any): string | null => {
                if (p.part === part) {
                  return p.parameters?.name || p.dispositionParameters?.filename || null;
                }
                if (p.childNodes) {
                  for (const child of p.childNodes) {
                    const found = findPart(child);
                    if (found) return found;
                  }
                }
                return null;
              };
              if (msg.bodyStructure) {
                attachName = findPart(msg.bodyStructure) || attachName;
              }
            }
          }

          // Download the specific MIME part
          const dl = await client.download(String(uid), part, { uid: true });
          if (!dl?.content) {
            return { error: 'Could not download attachment' };
          }

          const chunks: Buffer[] = [];
          for await (const chunk of dl.content) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const data = Buffer.concat(chunks);

          // Save to workspace
          const fs = await import('fs');
          const path = await import('path');
          const savePath = path.join('/workspace/group', attachName);
          fs.writeFileSync(savePath, data);

          return { path: savePath, size: data.length, name: attachName };
        } finally {
          lock.release();
        }
      });

      if ('error' in result) {
        return {
          content: [{ type: 'text' as const, text: String(result.error) }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Attachment saved: ${result.path} (${Math.round(result.size / 1024)}KB)`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
