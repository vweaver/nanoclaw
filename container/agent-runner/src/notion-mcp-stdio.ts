/**
 * Notion MCP Server for NanoClaw
 * Provides read/write access to Notion pages, databases, and search.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const NOTION_TOKEN = process.env.NOTION_API_TOKEN!;
const NOTION_VERSION = '2022-06-28';
const BASE_URL = 'https://api.notion.com/v1';

async function notionRequest(
  endpoint: string,
  method: string = 'GET',
  body?: object,
): Promise<{ status: number; data: any }> {
  const resp = await fetch(`${BASE_URL}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json();
  return { status: resp.status, data };
}

/** Extract plain text from Notion rich_text array. */
function richTextToPlain(richText: any[]): string {
  if (!richText) return '';
  return richText.map((t: any) => t.plain_text || '').join('');
}

/** Extract a readable title from a page's properties. */
function getPageTitle(properties: any): string {
  for (const [, prop] of Object.entries(properties || {})) {
    const p = prop as any;
    if (p.type === 'title') {
      return richTextToPlain(p.title);
    }
  }
  return '(untitled)';
}

/** Format page properties into a readable string. */
function formatProperties(properties: any): string {
  const lines: string[] = [];
  for (const [name, prop] of Object.entries(properties || {})) {
    const p = prop as any;
    let value = '';
    switch (p.type) {
      case 'title':
        value = richTextToPlain(p.title);
        break;
      case 'rich_text':
        value = richTextToPlain(p.rich_text);
        break;
      case 'number':
        value = p.number?.toString() ?? '';
        break;
      case 'select':
        value = p.select?.name || '';
        break;
      case 'multi_select':
        value = (p.multi_select || []).map((s: any) => s.name).join(', ');
        break;
      case 'date':
        value = p.date?.start || '';
        if (p.date?.end) value += ` → ${p.date.end}`;
        break;
      case 'checkbox':
        value = p.checkbox ? 'Yes' : 'No';
        break;
      case 'url':
        value = p.url || '';
        break;
      case 'email':
        value = p.email || '';
        break;
      case 'phone_number':
        value = p.phone_number || '';
        break;
      case 'status':
        value = p.status?.name || '';
        break;
      case 'people':
        value = (p.people || []).map((u: any) => u.name || u.id).join(', ');
        break;
      case 'relation':
        value = (p.relation || []).map((r: any) => r.id).join(', ');
        break;
      case 'formula':
        value = p.formula?.string || p.formula?.number?.toString() || '';
        break;
      default:
        value = `[${p.type}]`;
    }
    if (value) lines.push(`  ${name}: ${value}`);
  }
  return lines.join('\n');
}

/** Convert Notion blocks to readable text. */
function blocksToText(blocks: any[]): string {
  return blocks
    .map((b: any) => {
      const type = b.type;
      const content = b[type];
      if (!content) return '';

      if (content.rich_text) {
        const text = richTextToPlain(content.rich_text);
        switch (type) {
          case 'heading_1':
            return `# ${text}`;
          case 'heading_2':
            return `## ${text}`;
          case 'heading_3':
            return `### ${text}`;
          case 'bulleted_list_item':
            return `• ${text}`;
          case 'numbered_list_item':
            return `- ${text}`;
          case 'to_do':
            return `${content.checked ? '[x]' : '[ ]'} ${text}`;
          case 'quote':
            return `> ${text}`;
          case 'code':
            return `\`\`\`${content.language || ''}\n${text}\n\`\`\``;
          case 'callout':
            return `💡 ${text}`;
          default:
            return text;
        }
      }

      if (type === 'divider') return '---';
      if (type === 'child_page') return `📄 ${content.title}`;
      if (type === 'child_database') return `🗃️ ${content.title}`;
      if (type === 'image') {
        const url = content.file?.url || content.external?.url || '';
        return `[Image: ${url}]`;
      }

      return '';
    })
    .filter(Boolean)
    .join('\n');
}

// --- MCP Server ---

const server = new McpServer({
  name: 'notion',
  version: '1.0.0',
});

server.tool(
  'notion_search',
  'Search across all Notion pages and databases the integration has access to',
  {
    query: z.string().describe('Search query text'),
    filter: z
      .enum(['page', 'database'])
      .optional()
      .describe('Filter results to only pages or only databases'),
    page_size: z
      .number()
      .optional()
      .describe('Number of results (default 10, max 100)'),
  },
  async ({ query, filter, page_size }) => {
    try {
      const body: any = { query, page_size: page_size || 10 };
      if (filter) {
        body.filter = { value: filter, property: 'object' };
      }
      const resp = await notionRequest('/search', 'POST', body);
      if (resp.status !== 200) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Search failed (${resp.status}): ${JSON.stringify(resp.data)}`,
            },
          ],
          isError: true,
        };
      }

      const results = resp.data.results || [];
      if (results.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No results found.' },
          ],
        };
      }

      const formatted = results
        .map((r: any) => {
          const type = r.object;
          if (type === 'page') {
            const title = getPageTitle(r.properties);
            return `📄 ${title}\n  ID: ${r.id}\n  URL: ${r.url}`;
          } else if (type === 'database') {
            const title = richTextToPlain(r.title);
            return `🗃️ ${title}\n  ID: ${r.id}\n  URL: ${r.url}`;
          }
          return `${r.object}: ${r.id}`;
        })
        .join('\n\n');

      return {
        content: [{ type: 'text' as const, text: formatted }],
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
  'notion_get_page',
  'Get a Notion page content and properties by ID',
  {
    page_id: z.string().describe('Notion page ID (UUID)'),
  },
  async ({ page_id }) => {
    try {
      const [pageResp, blocksResp] = await Promise.all([
        notionRequest(`/pages/${page_id}`),
        notionRequest(`/blocks/${page_id}/children?page_size=100`),
      ]);

      if (pageResp.status !== 200) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to get page (${pageResp.status}): ${JSON.stringify(pageResp.data)}`,
            },
          ],
          isError: true,
        };
      }

      const title = getPageTitle(pageResp.data.properties);
      const props = formatProperties(pageResp.data.properties);
      const blocks =
        blocksResp.status === 200
          ? blocksToText(blocksResp.data.results || [])
          : '(could not load content)';

      const text = [
        `# ${title}`,
        `ID: ${pageResp.data.id}`,
        `URL: ${pageResp.data.url}`,
        '',
        '## Properties',
        props,
        '',
        '## Content',
        blocks,
      ].join('\n');

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
  'notion_query_database',
  'Query a Notion database with optional filters and sorts. Returns pages matching the query.',
  {
    database_id: z.string().describe('Notion database ID (UUID)'),
    filter: z
      .any()
      .optional()
      .describe(
        'Notion API filter object (see Notion API docs for filter syntax)',
      ),
    sorts: z
      .any()
      .optional()
      .describe(
        'Array of sort objects, e.g. [{"property": "Name", "direction": "ascending"}]',
      ),
    page_size: z
      .number()
      .optional()
      .describe('Number of results (default 25, max 100)'),
  },
  async ({ database_id, filter, sorts, page_size }) => {
    try {
      const body: any = { page_size: page_size || 25 };
      if (filter) body.filter = filter;
      if (sorts) body.sorts = sorts;

      const resp = await notionRequest(
        `/databases/${database_id}/query`,
        'POST',
        body,
      );

      if (resp.status !== 200) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Query failed (${resp.status}): ${JSON.stringify(resp.data)}`,
            },
          ],
          isError: true,
        };
      }

      const results = resp.data.results || [];
      if (results.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No results found.' },
          ],
        };
      }

      const formatted = results
        .map((r: any) => {
          const title = getPageTitle(r.properties);
          const props = formatProperties(r.properties);
          return `📄 ${title} (${r.id})\n${props}`;
        })
        .join('\n\n---\n\n');

      return {
        content: [
          {
            type: 'text' as const,
            text: `${results.length} results:\n\n${formatted}`,
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
  'notion_create_page',
  'Create a new Notion page. Can be a standalone page, a child of another page, or a new entry in a database.',
  {
    parent_type: z
      .enum(['page_id', 'database_id'])
      .describe('Type of parent: page_id or database_id'),
    parent_id: z.string().describe('ID of the parent page or database'),
    properties: z
      .record(z.string(), z.unknown())
      .describe(
        'Page properties. For databases, match the schema. For pages, use {"title": [{"text": {"content": "Title"}}]}',
      ),
    content: z
      .string()
      .optional()
      .describe(
        'Page content as markdown-like text. Will be converted to a paragraph block.',
      ),
  },
  async ({ parent_type, parent_id, properties, content }) => {
    try {
      const body: any = {
        parent: { [parent_type]: parent_id },
        properties,
      };

      if (content) {
        body.children = [
          {
            object: 'block',
            type: 'paragraph',
            paragraph: {
              rich_text: [{ type: 'text', text: { content } }],
            },
          },
        ];
      }

      const resp = await notionRequest('/pages', 'POST', body);

      if (resp.status === 200) {
        const title = getPageTitle(resp.data.properties);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Page created: "${title}"\nID: ${resp.data.id}\nURL: ${resp.data.url}`,
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed (${resp.status}): ${JSON.stringify(resp.data)}`,
            },
          ],
          isError: true,
        };
      }
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
  'notion_update_page',
  'Update properties of an existing Notion page',
  {
    page_id: z.string().describe('Notion page ID'),
    properties: z
      .record(z.string(), z.unknown())
      .describe('Properties to update (same format as create)'),
  },
  async ({ page_id, properties }) => {
    try {
      const resp = await notionRequest(`/pages/${page_id}`, 'PATCH', {
        properties,
      });

      if (resp.status === 200) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Page updated: ${resp.data.url}`,
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed (${resp.status}): ${JSON.stringify(resp.data)}`,
            },
          ],
          isError: true,
        };
      }
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
  'notion_append_blocks',
  'Append content blocks to a Notion page',
  {
    page_id: z.string().describe('Notion page or block ID to append to'),
    blocks: z
      .array(z.unknown())
      .describe(
        'Array of Notion block objects to append (see Notion API block format)',
      ),
  },
  async ({ page_id, blocks }) => {
    try {
      const resp = await notionRequest(
        `/blocks/${page_id}/children`,
        'PATCH',
        { children: blocks },
      );

      if (resp.status === 200) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Appended ${blocks.length} block(s) to page.`,
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed (${resp.status}): ${JSON.stringify(resp.data)}`,
            },
          ],
          isError: true,
        };
      }
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
  'notion_get_database',
  'Get a Notion database schema and metadata',
  {
    database_id: z.string().describe('Notion database ID'),
  },
  async ({ database_id }) => {
    try {
      const resp = await notionRequest(`/databases/${database_id}`);

      if (resp.status !== 200) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed (${resp.status}): ${JSON.stringify(resp.data)}`,
            },
          ],
          isError: true,
        };
      }

      const db = resp.data;
      const title = richTextToPlain(db.title);
      const props = Object.entries(db.properties || {})
        .map(([name, prop]: [string, any]) => `  ${name}: ${prop.type}`)
        .join('\n');

      return {
        content: [
          {
            type: 'text' as const,
            text: `🗃️ ${title}\nID: ${db.id}\nURL: ${db.url}\n\nProperties:\n${props}`,
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
