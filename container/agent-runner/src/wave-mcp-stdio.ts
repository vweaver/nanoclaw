/**
 * Read-only Wave Accounting MCP Server for NanoClaw
 * Provides access to invoices, transactions, customers, and accounts via Wave's GraphQL API.
 * No create/update/delete capabilities.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const WAVE_ACCESS_TOKEN = process.env.WAVE_FULL_ACCESS_TOKEN!;
const WAVE_ENDPOINT = 'https://gql.waveapps.com/graphql/public';

// Business ID is auto-discovered on first use
let cachedBusinessId: string | null = process.env.WAVE_BUSINESS_ID || null;

async function waveQuery(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<{ data?: any; errors?: any[] }> {
  const resp = await fetch(WAVE_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WAVE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  return resp.json() as Promise<{ data?: any; errors?: any[] }>;
}

/** Discover the first business ID from the user's account. */
async function getBusinessId(): Promise<string> {
  if (cachedBusinessId) return cachedBusinessId;

  const result = await waveQuery(`
    query {
      businesses(page: 1, pageSize: 10) {
        edges {
          node { id name }
        }
      }
    }
  `);

  const edges = result.data?.businesses?.edges;
  if (!edges?.length) {
    throw new Error('No businesses found on this Wave account');
  }

  cachedBusinessId = edges[0].node.id;
  return cachedBusinessId!;
}

function formatMoney(amount: any): string {
  if (!amount) return '';
  return `${amount.value} ${amount.currency?.code || ''}`.trim();
}

// --- MCP Server ---

const server = new McpServer({
  name: 'wave',
  version: '1.0.0',
});

server.tool(
  'wave_list_businesses',
  'List all businesses on the Wave account. Use this to find the business ID if you have multiple businesses.',
  {},
  async () => {
    try {
      const result = await waveQuery(`
        query {
          businesses(page: 1, pageSize: 50) {
            edges {
              node { id name isPersonal }
            }
          }
        }
      `);

      if (result.errors) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `API errors: ${JSON.stringify(result.errors)}`,
            },
          ],
          isError: true,
        };
      }

      const edges = result.data?.businesses?.edges;
      if (!edges?.length) {
        return {
          content: [
            { type: 'text' as const, text: 'No businesses found.' },
          ],
        };
      }

      const active = cachedBusinessId || '(auto-selects first)';
      const text = edges
        .map((e: any) => {
          const b = e.node;
          const marker = b.id === cachedBusinessId ? ' <-- active' : '';
          return `• ${b.name} (${b.isPersonal ? 'personal' : 'business'})${marker}\n  ID: ${b.id}`;
        })
        .join('\n\n');

      return {
        content: [
          {
            type: 'text' as const,
            text: `Active: ${active}\n\n${text}`,
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
  'wave_list_invoices',
  'List invoices from Wave accounting. Returns invoice number, status, customer, amounts, and dates.',
  {
    page: z.number().optional().describe('Page number (default 1)'),
    page_size: z.number().optional().describe('Results per page (default 25, max 50)'),
    status: z
      .enum(['DRAFT', 'SENT', 'VIEWED', 'PAID', 'OVERDUE', 'PARTIAL', 'UNPAID'])
      .optional()
      .describe('Filter by invoice status'),
  },
  async ({ page, page_size, status }) => {
    try {
      const query = `
        query ($businessId: ID!, $page: Int!, $pageSize: Int!) {
          business(id: $businessId) {
            invoices(page: $page, pageSize: $pageSize) {
              pageInfo {
                currentPage
                totalPages
                totalCount
              }
              edges {
                node {
                  id
                  status
                  invoiceNumber
                  invoiceDate
                  dueDate
                  amountDue { value currency { code } }
                  amountPaid { value currency { code } }
                  total { value currency { code } }
                  customer { id name email }
                  pdfUrl
                }
              }
            }
          }
        }
      `;

      const result = await waveQuery(query, {
        businessId: await getBusinessId(),
        page: page || 1,
        pageSize: Math.min(page_size || 25, 50),
      });

      if (result.errors) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `API errors: ${JSON.stringify(result.errors)}`,
            },
          ],
          isError: true,
        };
      }

      const invoices = result.data?.business?.invoices;
      if (!invoices?.edges?.length) {
        return {
          content: [{ type: 'text' as const, text: 'No invoices found.' }],
        };
      }

      let nodes = invoices.edges.map((e: any) => e.node);

      // Client-side status filter (Wave API doesn't support server-side filtering)
      if (status) {
        nodes = nodes.filter((n: any) => n.status === status);
      }

      const pageInfo = invoices.pageInfo;
      const header = `Page ${pageInfo.currentPage}/${pageInfo.totalPages} (${pageInfo.totalCount} total)`;

      const formatted = nodes
        .map((inv: any) => {
          const lines = [
            `#${inv.invoiceNumber || 'N/A'} — ${inv.status}`,
            `  Customer: ${inv.customer?.name || '(none)'}${inv.customer?.email ? ` (${inv.customer.email})` : ''}`,
            `  Total: ${formatMoney(inv.total)}`,
            `  Paid: ${formatMoney(inv.amountPaid)} | Due: ${formatMoney(inv.amountDue)}`,
            `  Date: ${inv.invoiceDate || ''} | Due: ${inv.dueDate || ''}`,
            `  ID: ${inv.id}`,
          ];
          if (inv.pdfUrl) lines.push(`  PDF: ${inv.pdfUrl}`);
          return lines.join('\n');
        })
        .join('\n\n');

      return {
        content: [
          { type: 'text' as const, text: `${header}\n\n${formatted}` },
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
  'wave_get_invoice',
  'Get full details of a specific invoice by invoice number',
  {
    invoice_number: z.string().describe('Invoice number (e.g., "0001")'),
  },
  async ({ invoice_number }) => {
    try {
      const query = `
        query ($businessId: ID!, $invoiceNumber: String!) {
          business(id: $businessId) {
            invoices(invoiceNumber: $invoiceNumber) {
              edges {
                node {
                  id
                  status
                  invoiceNumber
                  title
                  subhead
                  invoiceDate
                  dueDate
                  poNumber
                  amountDue { value currency { code } }
                  amountPaid { value currency { code } }
                  taxTotal { value currency { code } }
                  total { value currency { code } }
                  memo
                  footer
                  pdfUrl
                  viewUrl
                  customer { id name email }
                  items {
                    description
                    quantity
                    unitPrice
                    amount { value currency { code } }
                    product { name }
                    account { name }
                  }
                }
              }
            }
          }
        }
      `;

      const result = await waveQuery(query, {
        businessId: await getBusinessId(),
        invoiceNumber: invoice_number,
      });

      if (result.errors) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `API errors: ${JSON.stringify(result.errors)}`,
            },
          ],
          isError: true,
        };
      }

      const edges = result.data?.business?.invoices?.edges;
      if (!edges?.length) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invoice #${invoice_number} not found.`,
            },
          ],
        };
      }

      const inv = edges[0].node;
      const lines = [
        `Invoice #${inv.invoiceNumber} — ${inv.status}`,
        inv.title ? `Title: ${inv.title}` : '',
        inv.subhead ? `Subhead: ${inv.subhead}` : '',
        `Customer: ${inv.customer?.name || '(none)'}${inv.customer?.email ? ` (${inv.customer.email})` : ''}`,
        `Date: ${inv.invoiceDate || ''} | Due: ${inv.dueDate || ''}`,
        inv.poNumber ? `PO: ${inv.poNumber}` : '',
        '',
        '--- Line Items ---',
      ];

      for (const item of inv.items || []) {
        const product = item.product?.name ? `[${item.product.name}] ` : '';
        lines.push(
          `  ${product}${item.description || '(no description)'}`,
          `    Qty: ${item.quantity} × ${item.unitPrice} = ${formatMoney(item.amount)}`,
        );
      }

      lines.push(
        '',
        '--- Totals ---',
        `Subtotal: ${formatMoney(inv.total)}`,
        `Tax: ${formatMoney(inv.taxTotal)}`,
        `Total: ${formatMoney(inv.total)}`,
        `Paid: ${formatMoney(inv.amountPaid)}`,
        `Amount Due: ${formatMoney(inv.amountDue)}`,
      );

      if (inv.memo) lines.push('', `Memo: ${inv.memo}`);
      if (inv.footer) lines.push(`Footer: ${inv.footer}`);
      if (inv.pdfUrl) lines.push('', `PDF: ${inv.pdfUrl}`);
      if (inv.viewUrl) lines.push(`View: ${inv.viewUrl}`);
      lines.push(`ID: ${inv.id}`);

      return {
        content: [
          {
            type: 'text' as const,
            text: lines.filter(Boolean).join('\n'),
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
  'wave_list_transactions',
  'List accounting transactions from Wave. Returns date, description, amount, and account info.',
  {
    page: z.number().optional().describe('Page number (default 1)'),
    page_size: z.number().optional().describe('Results per page (default 25, max 50)'),
  },
  async ({ page, page_size }) => {
    try {
      const query = `
        query ($businessId: ID!, $page: Int!, $pageSize: Int!) {
          business(id: $businessId) {
            transactions(page: $page, pageSize: $pageSize) {
              pageInfo {
                currentPage
                totalPages
                totalCount
              }
              edges {
                node {
                  id
                  date
                  description
                  account { id name type { name } }
                  amount { value currency { code } }
                  direction
                  postedBy
                }
              }
            }
          }
        }
      `;

      const result = await waveQuery(query, {
        businessId: await getBusinessId(),
        page: page || 1,
        pageSize: Math.min(page_size || 25, 50),
      });

      if (result.errors) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `API errors: ${JSON.stringify(result.errors)}`,
            },
          ],
          isError: true,
        };
      }

      const txns = result.data?.business?.transactions;
      if (!txns?.edges?.length) {
        return {
          content: [
            { type: 'text' as const, text: 'No transactions found.' },
          ],
        };
      }

      const pageInfo = txns.pageInfo;
      const header = `Page ${pageInfo.currentPage}/${pageInfo.totalPages} (${pageInfo.totalCount} total)`;

      const formatted = txns.edges
        .map((e: any) => {
          const t = e.node;
          const dir = t.direction === 'DEPOSIT' ? '+' : '-';
          const acct = t.account?.name || '';
          const acctType = t.account?.type?.name ? ` (${t.account.type.name})` : '';
          return `${t.date} | ${dir}${formatMoney(t.amount)} | ${t.description || '(no description)'}\n  Account: ${acct}${acctType} | ID: ${t.id}`;
        })
        .join('\n\n');

      return {
        content: [
          { type: 'text' as const, text: `${header}\n\n${formatted}` },
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
  'wave_list_accounts',
  'List chart of accounts (bank accounts, expense categories, income categories, etc.)',
  {
    page: z.number().optional().describe('Page number (default 1)'),
    page_size: z.number().optional().describe('Results per page (default 50, max 100)'),
  },
  async ({ page, page_size }) => {
    try {
      const query = `
        query ($businessId: ID!, $page: Int!, $pageSize: Int!) {
          business(id: $businessId) {
            accounts(page: $page, pageSize: $pageSize) {
              pageInfo {
                currentPage
                totalPages
                totalCount
              }
              edges {
                node {
                  id
                  name
                  type { name value }
                  subtype { name value }
                  isArchived
                  balance
                  balanceInBusinessCurrency
                  currency { code }
                }
              }
            }
          }
        }
      `;

      const result = await waveQuery(query, {
        businessId: await getBusinessId(),
        page: page || 1,
        pageSize: Math.min(page_size || 50, 100),
      });

      if (result.errors) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `API errors: ${JSON.stringify(result.errors)}`,
            },
          ],
          isError: true,
        };
      }

      const accounts = result.data?.business?.accounts;
      if (!accounts?.edges?.length) {
        return {
          content: [
            { type: 'text' as const, text: 'No accounts found.' },
          ],
        };
      }

      const pageInfo = accounts.pageInfo;
      const header = `Page ${pageInfo.currentPage}/${pageInfo.totalPages} (${pageInfo.totalCount} total)`;

      const formatted = accounts.edges
        .filter((e: any) => !e.node.isArchived)
        .map((e: any) => {
          const a = e.node;
          const type = a.type?.name || '';
          const subtype = a.subtype?.name ? ` / ${a.subtype.name}` : '';
          const bal =
            a.balance != null
              ? ` | Balance: ${a.balance} ${a.currency?.code || ''}`
              : '';
          return `${a.name} (${type}${subtype})${bal}\n  ID: ${a.id}`;
        })
        .join('\n\n');

      return {
        content: [
          { type: 'text' as const, text: `${header}\n\n${formatted}` },
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
  'wave_list_customers',
  'List customers from Wave accounting',
  {
    page: z.number().optional().describe('Page number (default 1)'),
    page_size: z.number().optional().describe('Results per page (default 25, max 50)'),
  },
  async ({ page, page_size }) => {
    try {
      const query = `
        query ($businessId: ID!, $page: Int!, $pageSize: Int!) {
          business(id: $businessId) {
            customers(page: $page, pageSize: $pageSize) {
              pageInfo {
                currentPage
                totalPages
                totalCount
              }
              edges {
                node {
                  id
                  name
                  email
                  address {
                    addressLine1
                    addressLine2
                    city
                    province { name }
                    country { name }
                    postalCode
                  }
                  currency { code }
                  outstandingAmount { value currency { code } }
                  overdueAmount { value currency { code } }
                }
              }
            }
          }
        }
      `;

      const result = await waveQuery(query, {
        businessId: await getBusinessId(),
        page: page || 1,
        pageSize: Math.min(page_size || 25, 50),
      });

      if (result.errors) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `API errors: ${JSON.stringify(result.errors)}`,
            },
          ],
          isError: true,
        };
      }

      const customers = result.data?.business?.customers;
      if (!customers?.edges?.length) {
        return {
          content: [
            { type: 'text' as const, text: 'No customers found.' },
          ],
        };
      }

      const pageInfo = customers.pageInfo;
      const header = `Page ${pageInfo.currentPage}/${pageInfo.totalPages} (${pageInfo.totalCount} total)`;

      const formatted = customers.edges
        .map((e: any) => {
          const c = e.node;
          const lines = [`${c.name}`];
          if (c.email) lines.push(`  Email: ${c.email}`);
          if (c.address?.addressLine1) {
            const parts = [
              c.address.addressLine1,
              c.address.addressLine2,
              c.address.city,
              c.address.province?.name,
              c.address.postalCode,
              c.address.country?.name,
            ].filter(Boolean);
            lines.push(`  Address: ${parts.join(', ')}`);
          }
          if (c.outstandingAmount?.value && c.outstandingAmount.value !== '0.00') {
            lines.push(`  Outstanding: ${formatMoney(c.outstandingAmount)}`);
          }
          if (c.overdueAmount?.value && c.overdueAmount.value !== '0.00') {
            lines.push(`  Overdue: ${formatMoney(c.overdueAmount)}`);
          }
          lines.push(`  ID: ${c.id}`);
          return lines.join('\n');
        })
        .join('\n\n');

      return {
        content: [
          { type: 'text' as const, text: `${header}\n\n${formatted}` },
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
