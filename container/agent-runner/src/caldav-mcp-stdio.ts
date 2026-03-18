/**
 * CalDAV MCP Server for NanoClaw
 * Provides calendar read/write access via CalDAV protocol (Synology Calendar).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const CALDAV_URL = process.env.CALDAV_URL!;
const CALDAV_USERNAME = process.env.CALDAV_USERNAME!;
const CALDAV_PASSWORD = process.env.CALDAV_PASSWORD!;

const authHeader =
  'Basic ' +
  Buffer.from(`${CALDAV_USERNAME}:${CALDAV_PASSWORD}`).toString('base64');

const defaultHeaders: Record<string, string> = {
  Authorization: authHeader,
  'Content-Type': 'application/xml; charset=utf-8',
};

/** Make a CalDAV request. */
async function caldavRequest(
  url: string,
  method: string,
  body?: string,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; body: string; headers: Headers }> {
  const resp = await fetch(url, {
    method,
    headers: { ...defaultHeaders, ...extraHeaders },
    body,
  });
  const text = await resp.text();
  return { status: resp.status, body: text, headers: resp.headers };
}

/** Parse iCalendar VEVENT blocks into structured objects. */
function parseVEvents(ical: string): Array<Record<string, string>> {
  const events: Array<Record<string, string>> = [];
  const blocks = ical.split('BEGIN:VEVENT');
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split('END:VEVENT')[0];
    const event: Record<string, string> = {};
    // Handle unfolded lines (continuation lines start with space/tab)
    const unfolded = block.replace(/\r?\n[ \t]/g, '');
    for (const line of unfolded.split(/\r?\n/)) {
      const match = line.match(/^([A-Z\-;]+?)[:;](.+)/);
      if (match) {
        const key = match[1].split(';')[0]; // strip parameters
        event[key] = match[2];
      }
    }
    if (event.SUMMARY || event.DTSTART) {
      events.push(event);
    }
  }
  return events;
}

/** Build a minimal iCalendar VEVENT. */
function buildVEvent(opts: {
  uid: string;
  summary: string;
  dtstart: string;
  dtend?: string;
  description?: string;
  location?: string;
  allDay?: boolean;
}): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//NanoClaw//CalDAV MCP//EN',
    'BEGIN:VEVENT',
    `UID:${opts.uid}`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`,
  ];

  if (opts.allDay) {
    // All-day events use DATE format (YYYYMMDD)
    lines.push(`DTSTART;VALUE=DATE:${opts.dtstart.replace(/-/g, '')}`);
    if (opts.dtend) {
      lines.push(`DTEND;VALUE=DATE:${opts.dtend.replace(/-/g, '')}`);
    }
  } else {
    lines.push(`DTSTART:${opts.dtstart}`);
    if (opts.dtend) {
      lines.push(`DTEND:${opts.dtend}`);
    }
  }

  lines.push(`SUMMARY:${opts.summary}`);
  if (opts.description) lines.push(`DESCRIPTION:${opts.description}`);
  if (opts.location) lines.push(`LOCATION:${opts.location}`);

  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

/** Discover available calendars via PROPFIND. */
async function discoverCalendars(): Promise<
  Array<{ href: string; displayName: string }>
> {
  const body = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:displayname />
    <d:resourcetype />
  </d:prop>
</d:propfind>`;

  const resp = await caldavRequest(CALDAV_URL + '/', 'PROPFIND', body, {
    Depth: '1',
  });

  const calendars: Array<{ href: string; displayName: string }> = [];
  // Simple XML parsing for responses
  const responses = resp.body.split(/<d?:?response>/gi);
  for (const r of responses) {
    const hrefMatch = r.match(/<d?:?href>([^<]+)<\/d?:?href>/i);
    const nameMatch = r.match(/<d?:?displayname>([^<]*)<\/d?:?displayname>/i);
    const isCalendar =
      r.includes('calendar') && !r.includes('<d:collection/>') === false;
    // Check for calendar resourcetype
    const hasCalType =
      r.includes('urn:ietf:params:xml:ns:caldav') || r.includes(':calendar');

    if (hrefMatch && hasCalType) {
      calendars.push({
        href: hrefMatch[1],
        displayName: nameMatch ? nameMatch[1] : hrefMatch[1],
      });
    }
  }
  return calendars;
}

// --- MCP Server ---

const server = new McpServer({
  name: 'caldav',
  version: '1.0.0',
});

server.tool(
  'caldav_list_calendars',
  'List all available calendars',
  {},
  async () => {
    try {
      const calendars = await discoverCalendars();
      if (calendars.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No calendars found. The CalDAV URL may need adjusting.',
            },
          ],
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: calendars
              .map((c) => `• ${c.displayName} (${c.href})`)
              .join('\n'),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error listing calendars: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'caldav_get_events',
  'Get events from a calendar within a date range. Returns event details including UID, summary, start/end times, description, and location.',
  {
    calendar_href: z
      .string()
      .describe(
        'Calendar href path from caldav_list_calendars (e.g., /caldav/NanoClaw/calendar-name/)',
      ),
    start: z
      .string()
      .describe('Start date in ISO 8601 format (e.g., 2026-03-17T00:00:00Z)'),
    end: z
      .string()
      .describe('End date in ISO 8601 format (e.g., 2026-03-24T00:00:00Z)'),
  },
  async ({ calendar_href, start, end }) => {
    try {
      const startFmt = start.replace(/[-:]/g, '').replace(/\.\d+/, '');
      const endFmt = end.replace(/[-:]/g, '').replace(/\.\d+/, '');

      const body = `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag />
    <c:calendar-data />
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${startFmt}" end="${endFmt}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

      const calUrl = new URL(calendar_href, CALDAV_URL).href;
      const resp = await caldavRequest(calUrl, 'REPORT', body, {
        Depth: '1',
      });

      // Extract calendar-data from response
      const dataBlocks = resp.body.match(
        /<c(?:al)?:calendar-data[^>]*>([\s\S]*?)<\/c(?:al)?:calendar-data>/gi,
      );
      if (!dataBlocks || dataBlocks.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No events found in the specified date range.',
            },
          ],
        };
      }

      const allEvents: Array<Record<string, string>> = [];
      for (const block of dataBlocks) {
        const ical = block
          .replace(/<[^>]+>/g, '')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&');
        allEvents.push(...parseVEvents(ical));
      }

      if (allEvents.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No events found in range.' },
          ],
        };
      }

      const formatted = allEvents
        .map((e) => {
          const parts = [`• ${e.SUMMARY || '(no title)'}`];
          if (e.DTSTART) parts.push(`  Start: ${e.DTSTART}`);
          if (e.DTEND) parts.push(`  End: ${e.DTEND}`);
          if (e.LOCATION) parts.push(`  Location: ${e.LOCATION}`);
          if (e.DESCRIPTION)
            parts.push(`  Description: ${e.DESCRIPTION.slice(0, 200)}`);
          if (e.UID) parts.push(`  UID: ${e.UID}`);
          return parts.join('\n');
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
            text: `Error fetching events: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'caldav_create_event',
  'Create a new calendar event. For datetime events use ISO 8601 format (20260317T100000Z). For all-day events use YYYY-MM-DD format and set all_day to true.',
  {
    calendar_href: z
      .string()
      .describe('Calendar href path from caldav_list_calendars'),
    summary: z.string().describe('Event title'),
    dtstart: z
      .string()
      .describe(
        'Start time in iCalendar format (20260317T100000Z) or YYYY-MM-DD for all-day',
      ),
    dtend: z
      .string()
      .optional()
      .describe('End time (same format as dtstart). Optional for all-day.'),
    description: z.string().optional().describe('Event description'),
    location: z.string().optional().describe('Event location'),
    all_day: z
      .boolean()
      .optional()
      .describe('Set to true for all-day events (use YYYY-MM-DD for dates)'),
  },
  async ({ calendar_href, summary, dtstart, dtend, description, location, all_day }) => {
    try {
      const uid = `nanoclaw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@nanoclaw`;
      const ical = buildVEvent({
        uid,
        summary,
        dtstart,
        dtend,
        description,
        location,
        allDay: all_day,
      });

      const eventUrl = new URL(
        `${calendar_href}${uid}.ics`,
        CALDAV_URL,
      ).href;
      const resp = await caldavRequest(eventUrl, 'PUT', ical, {
        'Content-Type': 'text/calendar; charset=utf-8',
        'If-None-Match': '*',
      });

      if (resp.status >= 200 && resp.status < 300) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Event created: "${summary}" (UID: ${uid})`,
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to create event (HTTP ${resp.status}): ${resp.body.slice(0, 300)}`,
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
            text: `Error creating event: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'caldav_delete_event',
  'Delete a calendar event by its UID',
  {
    calendar_href: z
      .string()
      .describe('Calendar href path from caldav_list_calendars'),
    uid: z.string().describe('Event UID to delete'),
  },
  async ({ calendar_href, uid }) => {
    try {
      const eventUrl = new URL(
        `${calendar_href}${uid}.ics`,
        CALDAV_URL,
      ).href;
      const resp = await caldavRequest(eventUrl, 'DELETE');

      if (resp.status >= 200 && resp.status < 300) {
        return {
          content: [
            { type: 'text' as const, text: `Event deleted: ${uid}` },
          ],
        };
      } else {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to delete event (HTTP ${resp.status}): ${resp.body.slice(0, 300)}`,
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
            text: `Error deleting event: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'caldav_update_event',
  'Update an existing calendar event. Fetches the current event, then replaces it with updated fields.',
  {
    calendar_href: z
      .string()
      .describe('Calendar href path from caldav_list_calendars'),
    uid: z.string().describe('Event UID to update'),
    summary: z.string().optional().describe('New event title'),
    dtstart: z.string().optional().describe('New start time'),
    dtend: z.string().optional().describe('New end time'),
    description: z.string().optional().describe('New description'),
    location: z.string().optional().describe('New location'),
  },
  async ({ calendar_href, uid, summary, dtstart, dtend, description, location }) => {
    try {
      // Fetch current event
      const eventUrl = new URL(
        `${calendar_href}${uid}.ics`,
        CALDAV_URL,
      ).href;
      const getResp = await caldavRequest(eventUrl, 'GET');
      if (getResp.status !== 200) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Event not found (HTTP ${getResp.status})`,
            },
          ],
          isError: true,
        };
      }

      const existing = parseVEvents(getResp.body)[0];
      if (!existing) {
        return {
          content: [
            { type: 'text' as const, text: 'Could not parse existing event' },
          ],
          isError: true,
        };
      }

      const isAllDay =
        !!(existing.DTSTART && existing.DTSTART.length === 8);
      const ical = buildVEvent({
        uid,
        summary: summary || existing.SUMMARY || '(no title)',
        dtstart: dtstart || existing.DTSTART || '',
        dtend: dtend || existing.DTEND,
        description: description ?? existing.DESCRIPTION,
        location: location ?? existing.LOCATION,
        allDay: isAllDay,
      });

      const putResp = await caldavRequest(eventUrl, 'PUT', ical, {
        'Content-Type': 'text/calendar; charset=utf-8',
      });

      if (putResp.status >= 200 && putResp.status < 300) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Event updated: "${summary || existing.SUMMARY}"`,
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to update (HTTP ${putResp.status}): ${putResp.body.slice(0, 300)}`,
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
            text: `Error updating event: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
