/**
 * Reassembles a `session/update` stream into readable records.
 *
 * A real agent streams token by token, so one prompt turn can produce a
 * thousand `session/update` notifications. Individually they are noise; the
 * message the agent actually produced only exists as the concatenation of their
 * content chunks. This module does that concatenation.
 *
 * Deliberately pure and dependency-free so it can be unit tested directly from
 * the compiled output, without a DOM or a browser.
 */

import type { LogEntry } from './wire.js';

export type GroupRole =
  | 'agent'
  | 'agent_thought'
  | 'user'
  | 'tool'
  | 'plan'
  | 'usage'
  | 'commands'
  | 'mode'
  | 'config'
  | 'info';

export interface TranscriptGroup {
  /** Stable identity for selection, derived from the grouping key. */
  key: string;
  role: GroupRole;
  /** Human label for the row, e.g. `agent message`. */
  label: string;
  /** Joined text for chunk groups; a summary line for the others. */
  text: string;
  /** Number of `session/update` frames folded into this row. */
  count: number;
  firstSeq: number;
  lastSeq: number;
  ts: number;
  endTs: number;
  /** Sequence numbers of every folded frame, so the detail pane can list them. */
  seqs: number[];
  /** Set for tool groups. */
  toolCallId?: string;
  toolStatus?: string;
  toolKind?: string;
  /** Non-text content encountered, e.g. `image/png`, for chunk groups. */
  attachments?: string[];
}

export type TimelineRow =
  | { type: 'frame'; id: string; seq: number; entry: LogEntry }
  | { type: 'group'; id: string; seq: number; group: TranscriptGroup };

export function frameRowId(seq: number): string {
  return `f:${seq}`;
}

export function groupRowId(key: string): string {
  return `g:${key}`;
}

const CHUNK_ROLES: Record<string, GroupRole> = {
  agent_message_chunk: 'agent',
  agent_thought_chunk: 'agent_thought',
  user_message_chunk: 'user',
};

const ROLE_LABELS: Record<GroupRole, string> = {
  agent: 'agent message',
  agent_thought: 'agent thought',
  user: 'user message',
  tool: 'tool call',
  plan: 'plan',
  usage: 'usage',
  commands: 'available commands',
  mode: 'mode',
  config: 'config options',
  info: 'session info',
};

/**
 * Folds every `session/update` frame into grouped rows, leaving all other
 * frames untouched and in place.
 *
 * A group is emitted at the position of its FIRST constituent frame, so the
 * transcript reads in the order the agent started each thing, even when chunks
 * for one message are interleaved with a tool call. Chunks are keyed by
 * `messageId` where the agent supplies one, because ACP defines that as the
 * marker for chunks belonging to the same message; without it, consecutive
 * chunks of the same role are merged and a non-chunk frame closes the run.
 */
export function collapseUpdates(entries: LogEntry[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const groups = new Map<string, TranscriptGroup>();
  /** Key of the run currently open per role, for chunks with no messageId. */
  const openRun = new Map<GroupRole, string>();

  for (const entry of entries) {
    if (entry.method !== 'session/update' || entry.msg === undefined) {
      rows.push({ type: 'frame', id: frameRowId(entry.seq), seq: entry.seq, entry });
      // Anything that is not a session/update ends the implicit chunk runs, so
      // text from either side of an unrelated frame is not silently welded.
      openRun.clear();
      continue;
    }

    const update = readUpdate(entry);
    if (update === null) {
      rows.push({ type: 'frame', id: frameRowId(entry.seq), seq: entry.seq, entry });
      continue;
    }

    const resolved = keyFor(update, entry, openRun);
    if (resolved === null) {
      rows.push({ type: 'frame', id: frameRowId(entry.seq), seq: entry.seq, entry });
      continue;
    }

    const { key, role } = resolved;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        key,
        role,
        label: ROLE_LABELS[role],
        text: '',
        count: 0,
        firstSeq: entry.seq,
        lastSeq: entry.seq,
        ts: entry.ts,
        endTs: entry.ts,
        seqs: [],
      };
      groups.set(key, group);
      rows.push({ type: 'group', id: groupRowId(key), seq: entry.seq, group });
    }

    group.count += 1;
    group.lastSeq = entry.seq;
    group.endTs = entry.ts;
    group.seqs.push(entry.seq);
    absorb(group, update);
  }

  return rows;
}

interface UpdatePayload {
  sessionUpdate: string;
  raw: Record<string, unknown>;
}

function readUpdate(entry: LogEntry): UpdatePayload | null {
  const params = (entry.msg as { params?: unknown } | undefined)?.params;
  if (typeof params !== 'object' || params === null) return null;
  const update = (params as { update?: unknown }).update;
  if (typeof update !== 'object' || update === null) return null;
  const raw = update as Record<string, unknown>;
  const sessionUpdate = raw.sessionUpdate;
  if (typeof sessionUpdate !== 'string') return null;
  return { sessionUpdate, raw };
}

function keyFor(
  update: UpdatePayload,
  entry: LogEntry,
  openRun: Map<GroupRole, string>,
): { key: string; role: GroupRole } | null {
  const chunkRole = CHUNK_ROLES[update.sessionUpdate];
  if (chunkRole !== undefined) {
    const messageId = update.raw.messageId;
    if (typeof messageId === 'string' && messageId.length > 0) {
      return { key: `msg:${chunkRole}:${messageId}`, role: chunkRole };
    }
    const existing = openRun.get(chunkRole);
    if (existing !== undefined) return { key: existing, role: chunkRole };
    const key = `run:${chunkRole}:${entry.seq}`;
    openRun.set(chunkRole, key);
    return { key, role: chunkRole };
  }

  // A tool call and all its updates are one row, keyed by the call id.
  if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    const toolCallId = update.raw.toolCallId;
    if (typeof toolCallId !== 'string') return null;
    return { key: `tool:${toolCallId}`, role: 'tool' };
  }

  // These carry a full snapshot each time, so one row showing the latest wins.
  switch (update.sessionUpdate) {
    case 'plan':
      return { key: 'plan', role: 'plan' };
    case 'usage_update':
      return { key: 'usage', role: 'usage' };
    case 'available_commands_update':
      return { key: 'commands', role: 'commands' };
    case 'current_mode_update':
      return { key: 'mode', role: 'mode' };
    case 'config_option_update':
      return { key: 'config', role: 'config' };
    case 'session_info_update':
      return { key: 'info', role: 'info' };
    default:
      return null;
  }
}

function absorb(group: TranscriptGroup, update: UpdatePayload): void {
  switch (group.role) {
    case 'agent':
    case 'agent_thought':
    case 'user': {
      const { text, attachment } = readContent(update.raw.content);
      group.text += text;
      if (attachment !== null) {
        group.attachments = [...(group.attachments ?? []), attachment];
      }
      return;
    }

    case 'tool': {
      const title = update.raw.title;
      if (typeof title === 'string' && title.length > 0) group.text = title;
      const status = update.raw.status;
      if (typeof status === 'string') group.toolStatus = status;
      const kind = update.raw.kind;
      if (typeof kind === 'string') group.toolKind = kind;
      const toolCallId = update.raw.toolCallId;
      if (typeof toolCallId === 'string') group.toolCallId = toolCallId;
      if (group.text === '') group.text = group.toolCallId ?? 'tool call';
      return;
    }

    case 'plan': {
      const entries = update.raw.entries;
      group.text = Array.isArray(entries) ? summarisePlan(entries) : 'plan updated';
      return;
    }

    case 'usage': {
      const used = update.raw.used;
      const size = update.raw.size;
      const cost = update.raw.cost;
      const parts = [`${String(used)}/${String(size)} tokens`];
      if (cost !== undefined && cost !== null) parts.push(`cost ${JSON.stringify(cost)}`);
      group.text = parts.join(' · ');
      return;
    }

    default:
      // The remaining snapshot kinds are shown as their latest payload.
      group.text = JSON.stringify(stripDiscriminator(update.raw));
  }
}

function summarisePlan(entries: unknown[]): string {
  const counts = new Map<string, number>();
  for (const item of entries) {
    if (typeof item !== 'object' || item === null) continue;
    const status = (item as { status?: unknown }).status;
    const key = typeof status === 'string' ? status : 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const summary = [...counts.entries()].map(([status, n]) => `${n} ${status}`).join(', ');
  return `${entries.length} entries (${summary})`;
}

function stripDiscriminator(raw: Record<string, unknown>): Record<string, unknown> {
  const { sessionUpdate: _ignored, ...rest } = raw;
  return rest;
}

/**
 * Pulls displayable text out of a ContentBlock.
 *
 * Non-text blocks cannot be concatenated into a transcript, so they are noted
 * as attachments rather than dropped: silently losing an image from the stream
 * would misrepresent what the agent sent.
 */
function readContent(content: unknown): { text: string; attachment: string | null } {
  if (typeof content !== 'object' || content === null) {
    return { text: '', attachment: null };
  }
  const block = content as Record<string, unknown>;
  switch (block.type) {
    case 'text':
      return { text: typeof block.text === 'string' ? block.text : '', attachment: null };
    case 'image':
    case 'audio':
      return {
        text: '',
        attachment: `${String(block.type)} ${String(block.mimeType ?? 'unknown')}`,
      };
    case 'resource_link':
      return { text: '', attachment: `resource_link ${String(block.uri ?? '')}` };
    case 'resource':
      return { text: '', attachment: 'resource' };
    default:
      return { text: '', attachment: block.type === undefined ? null : String(block.type) };
  }
}
