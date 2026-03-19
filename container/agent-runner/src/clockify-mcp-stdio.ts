/**
 * Clockify MCP Server for NanoClaw
 * Read + create for clients, projects, tasks. Read-only for time entries.
 * No update or delete on anything.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_KEY = process.env.CLOCKIFY_API_KEY!;
const BASE = 'https://api.clockify.me/api/v1';
const REPORTS_BASE = 'https://reports.api.clockify.me/v1';

async function clockifyGet(endpoint: string): Promise<any> {
  const resp = await fetch(`${BASE}${endpoint}`, {
    headers: { 'X-Api-Key': API_KEY },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Clockify ${resp.status}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

async function clockifyPost(endpoint: string, body: object): Promise<any> {
  const resp = await fetch(`${BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'X-Api-Key': API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Clockify ${resp.status}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

async function reportsPost(endpoint: string, body: object): Promise<any> {
  const resp = await fetch(`${REPORTS_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'X-Api-Key': API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Clockify Reports ${resp.status}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

// Auto-discover workspace and user
let cachedWorkspaceId: string | null = null;
let cachedUserId: string | null = null;

async function getWorkspaceId(): Promise<string> {
  if (cachedWorkspaceId) return cachedWorkspaceId;
  const user = await clockifyGet('/user');
  cachedWorkspaceId = user.activeWorkspace || user.defaultWorkspace;
  cachedUserId = user.id;
  return cachedWorkspaceId!;
}

async function getUserId(): Promise<string> {
  if (cachedUserId) return cachedUserId;
  await getWorkspaceId(); // populates both
  return cachedUserId!;
}

function formatDuration(dur: string | null): string {
  if (!dur) return '';
  // PT1H30M45S format
  const match = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return dur;
  const h = match[1] || '0';
  const m = (match[2] || '0').padStart(2, '0');
  const s = (match[3] || '0').padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function errResult(err: unknown) {
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

// --- MCP Server ---

const server = new McpServer({
  name: 'clockify',
  version: '1.0.0',
});

// --- Workspaces (read) ---

server.tool(
  'clockify_list_workspaces',
  'List all Clockify workspaces',
  {},
  async () => {
    try {
      const workspaces = await clockifyGet('/workspaces');
      const activeWs = await getWorkspaceId();
      const text = workspaces
        .map((w: any) => {
          const marker = w.id === activeWs ? ' <-- active' : '';
          return `• ${w.name}${marker}\n  ID: ${w.id}`;
        })
        .join('\n\n');
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return errResult(err);
    }
  },
);

// --- Clients (read + create) ---

server.tool(
  'clockify_list_clients',
  'List all clients in the workspace',
  {},
  async () => {
    try {
      const wsId = await getWorkspaceId();
      const clients = await clockifyGet(`/workspaces/${wsId}/clients`);
      if (!clients.length) {
        return { content: [{ type: 'text' as const, text: 'No clients found.' }] };
      }
      const text = clients
        .map((c: any) => {
          const archived = c.archived ? ' [archived]' : '';
          return `• ${c.name}${archived}\n  ID: ${c.id}`;
        })
        .join('\n\n');
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return errResult(err);
    }
  },
);

server.tool(
  'clockify_create_client',
  'Create a new client in the workspace',
  {
    name: z.string().describe('Client name'),
    note: z.string().optional().describe('Optional note about the client'),
  },
  async ({ name, note }) => {
    try {
      const wsId = await getWorkspaceId();
      const body: any = { name };
      if (note) body.note = note;
      const client = await clockifyPost(`/workspaces/${wsId}/clients`, body);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Client created: "${client.name}"\nID: ${client.id}`,
          },
        ],
      };
    } catch (err) {
      return errResult(err);
    }
  },
);

// --- Projects (read + create) ---

server.tool(
  'clockify_list_projects',
  'List all projects in the workspace',
  {
    archived: z.boolean().optional().describe('Include archived projects (default false)'),
  },
  async ({ archived }) => {
    try {
      const wsId = await getWorkspaceId();
      const params = archived ? '?archived=true' : '';
      const projects = await clockifyGet(`/workspaces/${wsId}/projects${params}`);
      if (!projects.length) {
        return { content: [{ type: 'text' as const, text: 'No projects found.' }] };
      }
      const text = projects
        .map((p: any) => {
          const client = p.clientName ? ` (${p.clientName})` : '';
          const status = p.archived ? ' [archived]' : '';
          const billable = p.billable ? ' [billable]' : '';
          return `• ${p.name}${client}${status}${billable}\n  ID: ${p.id} | Color: ${p.color || 'none'}`;
        })
        .join('\n\n');
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return errResult(err);
    }
  },
);

server.tool(
  'clockify_create_project',
  'Create a new project in the workspace',
  {
    name: z.string().describe('Project name'),
    client_id: z.string().optional().describe('Client ID to associate with'),
    billable: z.boolean().optional().describe('Is the project billable (default false)'),
    color: z.string().optional().describe('Project color hex (e.g., "#0099FF")'),
    note: z.string().optional().describe('Project note'),
  },
  async ({ name, client_id, billable, color, note }) => {
    try {
      const wsId = await getWorkspaceId();
      const body: any = { name, isPublic: true };
      if (client_id) body.clientId = client_id;
      if (billable !== undefined) body.billable = billable;
      if (color) body.color = color;
      if (note) body.note = note;
      const project = await clockifyPost(`/workspaces/${wsId}/projects`, body);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Project created: "${project.name}"\nID: ${project.id}`,
          },
        ],
      };
    } catch (err) {
      return errResult(err);
    }
  },
);

// --- Tasks (read + create) ---

server.tool(
  'clockify_list_tasks',
  'List tasks for a project',
  {
    project_id: z.string().describe('Project ID'),
  },
  async ({ project_id }) => {
    try {
      const wsId = await getWorkspaceId();
      const tasks = await clockifyGet(
        `/workspaces/${wsId}/projects/${project_id}/tasks`,
      );
      if (!tasks.length) {
        return { content: [{ type: 'text' as const, text: 'No tasks found.' }] };
      }
      const text = tasks
        .map((t: any) => {
          const status = t.status === 'DONE' ? ' [done]' : '';
          const assignees = t.assigneeIds?.length
            ? ` (${t.assigneeIds.length} assignee${t.assigneeIds.length > 1 ? 's' : ''})`
            : '';
          return `• ${t.name}${status}${assignees}\n  ID: ${t.id}`;
        })
        .join('\n\n');
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return errResult(err);
    }
  },
);

server.tool(
  'clockify_create_task',
  'Create a new task in a project',
  {
    project_id: z.string().describe('Project ID'),
    name: z.string().describe('Task name'),
  },
  async ({ project_id, name }) => {
    try {
      const wsId = await getWorkspaceId();
      const task = await clockifyPost(
        `/workspaces/${wsId}/projects/${project_id}/tasks`,
        { name },
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: `Task created: "${task.name}"\nID: ${task.id}`,
          },
        ],
      };
    } catch (err) {
      return errResult(err);
    }
  },
);

// --- Time Entries (read only) ---

server.tool(
  'clockify_list_time_entries',
  'List time entries (read-only). Returns recent entries by default.',
  {
    start: z.string().optional().describe('Start date filter (ISO 8601, e.g., 2026-03-01T00:00:00Z)'),
    end: z.string().optional().describe('End date filter (ISO 8601)'),
    project_id: z.string().optional().describe('Filter by project ID'),
    page_size: z.number().optional().describe('Results per page (default 50, max 200)'),
    page: z.number().optional().describe('Page number (default 1)'),
  },
  async ({ start, end, project_id, page_size, page }) => {
    try {
      const wsId = await getWorkspaceId();
      const userId = await getUserId();

      const params = new URLSearchParams();
      if (start) params.set('start', start);
      if (end) params.set('end', end);
      if (project_id) params.set('project', project_id);
      params.set('page-size', String(Math.min(page_size || 50, 200)));
      params.set('page', String(page || 1));

      const entries = await clockifyGet(
        `/workspaces/${wsId}/user/${userId}/time-entries?${params}`,
      );

      if (!entries.length) {
        return { content: [{ type: 'text' as const, text: 'No time entries found.' }] };
      }

      const text = entries
        .map((e: any) => {
          const project = e.projectId ? ` [${e.projectId}]` : '';
          const task = e.taskId ? ` task:${e.taskId}` : '';
          const duration = formatDuration(e.timeInterval?.duration);
          const start = e.timeInterval?.start
            ? new Date(e.timeInterval.start).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })
            : '';
          const billable = e.billable ? ' $' : '';
          const tags = e.tagIds?.length ? ` tags:${e.tagIds.length}` : '';
          return `${start} | ${duration}${billable} | ${e.description || '(no description)'}${project}${task}${tags}\n  ID: ${e.id}`;
        })
        .join('\n\n');

      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return errResult(err);
    }
  },
);

// --- Reports (read only) ---

server.tool(
  'clockify_summary_report',
  'Get a summary report of tracked time grouped by project, client, or user',
  {
    start: z.string().describe('Start date (ISO 8601, e.g., 2026-03-01T00:00:00Z)'),
    end: z.string().describe('End date (ISO 8601)'),
    group_by: z
      .enum(['PROJECT', 'CLIENT', 'USER', 'TAG', 'TASK'])
      .optional()
      .describe('Group results by (default PROJECT)'),
  },
  async ({ start, end, group_by }) => {
    try {
      const wsId = await getWorkspaceId();
      const body = {
        dateRangeStart: start,
        dateRangeEnd: end,
        summaryFilter: {
          groups: [group_by || 'PROJECT'],
        },
      };

      const report = await reportsPost(
        `/workspaces/${wsId}/reports/summary`,
        body,
      );

      const groups = report.groupOne || [];
      if (!groups.length) {
        return {
          content: [{ type: 'text' as const, text: 'No data in this date range.' }],
        };
      }

      const totalDuration = formatDuration(report.totals?.[0]?.totalTime || null);
      const totalAmount = report.totals?.[0]?.totalBillableAmount || 0;

      const text = groups
        .map((g: any) => {
          const dur = formatDuration(g.duration);
          const amt = g.amount ? ` | $${g.amount}` : '';
          return `• ${g.name || '(unnamed)'} — ${dur}${amt}`;
        })
        .join('\n');

      const header = `Total: ${totalDuration}${totalAmount ? ` | $${totalAmount}` : ''}`;
      return {
        content: [{ type: 'text' as const, text: `${header}\n\n${text}` }],
      };
    } catch (err) {
      return errResult(err);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
