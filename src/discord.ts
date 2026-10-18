import type { Engagement } from "./blog.js";

/**
 * Discord Ed25519 서명 검증
 */
export async function verifySignature(
  publicKey: string,
  signature: string,
  timestamp: string,
  body: string,
): Promise<boolean> {
  const publicKeyBytes = hexToBytes(publicKey);
  const signatureBytes = hexToBytes(signature);
  const message = new TextEncoder().encode(timestamp + body);

  const key = await crypto.subtle.importKey(
    "raw",
    publicKeyBytes,
    { name: "Ed25519" },
    false,
    ["verify"],
  );

  return crypto.subtle.verify("Ed25519", key, signatureBytes, message);
}

/**
 * Discord 역할 부여
 */
export async function assignRole(
  guildId: string,
  userId: string,
  roleId: string,
  botToken: string,
): Promise<void> {
  const response = await fetch(
    `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json",
      },
    },
  );

  if (!response.ok && response.status !== 204) {
    const data = await response.json() as any;
    throw new Error(`Failed to assign Discord role: ${JSON.stringify(data)}`);
  }
}

/**
 * Discord 포럼 채널의 포스트(스레드) 목록 및 첫 메시지 조회
 */
export async function getForumPosts(
  guildId: string,
  forumChannelId: string,
  botToken: string,
): Promise<any[]> {
  const headers = { Authorization: `Bot ${botToken}` };

  const activeRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/threads/active`, { headers });

  if (!activeRes.ok) {
    const data = await activeRes.json() as any;
    throw new Error(`Failed to get active threads: ${JSON.stringify(data)}`);
  }

  const activeData = await activeRes.json() as any;
  const allThreads = (activeData.threads ?? []).filter((t: any) => t.parent_id === forumChannelId);

  const posts = await Promise.all(
    allThreads.map(async (thread: any) => {
      const msgRes = await fetch(
        `https://discord.com/api/v10/channels/${thread.id}/messages?limit=10`,
        { headers },
      );
      if (!msgRes.ok) {
        const err = await msgRes.json();
        console.log(`[discord] failed to fetch messages threadId=${thread.id} status=${msgRes.status} err=${JSON.stringify(err)}`);
        return null;
      }
      const messages = await msgRes.json() as any[];
      console.log(`[discord] threadId=${thread.id} messageCount=${messages.length} contents=${JSON.stringify(messages.map((m: any) => ({ id: m.id, bot: m.author?.bot, content: m.content })))}`);
      const msg = messages.reverse().find((m: any) => !m.author?.bot);
      if (!msg) return null;
      return { ...msg, threadId: thread.id, threadName: thread.name };
    }),
  );

  return posts.filter(Boolean);
}

/**
 * Discord 메시지에 Reply 전송
 */
export async function replyToMessage(
  channelId: string,
  messageId: string,
  content: string,
  botToken: string,
): Promise<void> {
  const response = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content,
        message_reference: { message_id: messageId },
      }),
    },
  );

  if (!response.ok) {
    const data = await response.json() as any;
    throw new Error(`Failed to reply to message: ${JSON.stringify(data)}`);
  }
}

/**
 * Discord 메시지에 Reaction 추가
 */
export async function addReaction(
  channelId: string,
  messageId: string,
  emoji: string,
  botToken: string,
): Promise<void> {
  const encoded = encodeURIComponent(emoji);
  const response = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bot ${botToken}`,
      },
    },
  );

  if (!response.ok && response.status !== 204) {
    const data = await response.json() as any;
    throw new Error(`Failed to add reaction: ${JSON.stringify(data)}`);
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ── 블로그 발행 체크(blog-study) 헬퍼 ──────────────────────────────
// 게이트웨이 없이 Discord REST v10 fetch 만으로 동작한다.
const API = "https://discord.com/api/v10";

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bot ${token}` };
}

async function ensureOk(res: Response, what: string): Promise<void> {
  if (!res.ok && res.status !== 204) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text();
    }
    throw new Error(`${what} 실패 (status=${res.status}): ${JSON.stringify(body)}`);
  }
}

/** Discord snowflake epoch (2015-01-01T00:00:00Z, UTC ms) */
const DISCORD_EPOCH_MS = 1420070400000;

/** snowflake ID에 인코딩된 생성 시각 (UTC ms) */
export function snowflakeToMs(id: string): number {
  return Number(BigInt(id) >> 22n) + DISCORD_EPOCH_MS;
}

export interface WeeklyThread {
  threadId: string;
  ownerId: string;
  createdMs: number;
  title: string;
}

/**
 * 포럼 채널의 게시글(스레드) 중 [lastMonday9, thisMonday9] 창 안에 만들어진 것을 모은다.
 * 생성 시각은 게시글 ID(snowflake)에서 얻으므로 메시지 내용은 전혀 읽지 않는다.
 * 활성 게시글(길드) + 보관된 게시글(채널)을 모두 본다.
 */
export async function collectWeeklyThreads(
  guildId: string,
  forumChannelId: string,
  token: string,
  lastMonday9Ms: number,
  thisMonday9Ms: number,
): Promise<WeeklyThread[]> {
  const headers = authHeaders(token);
  const threads: WeeklyThread[] = [];
  const consider = (t: any) => {
    if (t.parent_id !== forumChannelId || !t.owner_id) return;
    const ts = snowflakeToMs(t.id);
    if (ts < lastMonday9Ms || ts > thisMonday9Ms) return;
    threads.push({ threadId: t.id, ownerId: t.owner_id, createdMs: ts, title: t.name });
  };

  // 활성 게시글
  const activeRes = await fetch(`${API}/guilds/${guildId}/threads/active`, { headers });
  await ensureOk(activeRes, "활성 게시글 조회");
  const active = (await activeRes.json()) as any;
  for (const t of active.threads ?? []) consider(t);

  // 보관된 게시글 (archive_timestamp 기준 페이지네이션)
  let before: string | undefined;
  while (true) {
    const url = new URL(`${API}/channels/${forumChannelId}/threads/archived/public`);
    url.searchParams.set("limit", "100");
    if (before) url.searchParams.set("before", before);
    const res = await fetch(url, { headers });
    await ensureOk(res, "보관 게시글 조회");
    const page = (await res.json()) as any;
    const threads: any[] = page.threads ?? [];
    if (threads.length === 0) break;
    for (const t of threads) consider(t);
    if (!page.has_more) break;
    before = threads[threads.length - 1]?.thread_metadata?.archive_timestamp;
    if (!before) break;
  }

  return threads;
}

/**
 * 게시글의 반응/댓글을 집계한다. 작성자 본인과 봇의 기여는 제외한다.
 * 포럼 게시글은 스레드 ID가 곧 첫 메시지 ID라서, 스레드 메시지 목록 한 번이면
 * 첫 글에 달린 반응 종류와 댓글 작성자를 모두 얻는다.
 */
export async function getEngagement(
  thread: WeeklyThread,
  token: string,
): Promise<Engagement> {
  const { threadId, ownerId } = thread;
  const headers = authHeaders(token);

  const res = await fetch(`${API}/channels/${threadId}/messages?limit=100`, { headers });
  await ensureOk(res, "게시글 메시지 조회");
  const messages = (await res.json()) as any[];

  const comments = messages.filter(
    (m) => m.id !== threadId && !m.author?.bot && m.author?.id !== ownerId,
  ).length;

  // 이모지 종류가 달라도 같은 사람이면 1명으로 센다.
  const reactors = new Set<string>();
  const starter = messages.find((m) => m.id === threadId);
  for (const r of starter?.reactions ?? []) {
    const emoji = r.emoji.id ? `${r.emoji.name}:${r.emoji.id}` : r.emoji.name;
    const usersRes = await fetch(
      `${API}/channels/${threadId}/messages/${threadId}/reactions/${encodeURIComponent(emoji)}?limit=100`,
      { headers },
    );
    await ensureOk(usersRes, "반응 사용자 조회");
    for (const u of (await usersRes.json()) as any[]) {
      if (!u.bot && u.id !== ownerId) reactors.add(u.id);
    }
  }

  return { reactors: reactors.size, comments };
}

export interface GuildMember {
  id: string;
  /** username, 서버 닉네임, 표시 이름 중 있는 것 — GitHub 아이디와 대조할 때 쓴다 */
  names: string[];
  roles: string[];
}

/**
 * 주어진 역할 중 하나라도 가진 사람(비봇) 목록 — 페이지네이션.
 * 길드 멤버 전체를 한 번만 훑으므로 여러 역할을 함께 조회하는 편이 싸다.
 * ⚠️ GET /guilds/{id}/members 는 GUILD_MEMBERS(privileged) 인텐트가 켜져 있어야 동작한다.
 */
export async function listMembersWithRoles(
  guildId: string,
  roleIds: string[],
  token: string,
): Promise<GuildMember[]> {
  const headers = authHeaders(token);
  const found: GuildMember[] = [];
  let after = "0";

  while (true) {
    const url = new URL(`${API}/guilds/${guildId}/members`);
    url.searchParams.set("limit", "1000");
    url.searchParams.set("after", after);
    const res = await fetch(url, { headers });
    await ensureOk(res, "길드 멤버 조회");
    const members = (await res.json()) as any[];
    if (members.length === 0) break;
    for (const m of members) {
      const roles: string[] = m.roles ?? [];
      if (m.user?.bot || !roleIds.some((r) => roles.includes(r))) continue;
      found.push({
        id: m.user.id,
        names: [m.user.username, m.nick, m.user.global_name].filter(Boolean),
        roles,
      });
    }
    after = members[members.length - 1].user.id;
    if (members.length < 1000) break;
  }

  return found;
}

/** 특정 역할을 가진 사람(비봇) ID 목록 */
export async function listRoleMembers(
  guildId: string,
  roleId: string,
  token: string,
): Promise<string[]> {
  const members = await listMembersWithRoles(guildId, [roleId], token);
  return members.map((m) => m.id);
}

/**
 * 채널에 텍스트 메시지 게시하고 그 메시지 ID를 돌려준다.
 * pingUsers=false 면 멘션이 이름으로 보이기만 하고 알림은 가지 않는다.
 */
export async function postMessage(
  channelId: string,
  content: string,
  token: string,
  pingUsers = true,
): Promise<string> {
  const res = await fetch(`${API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { parse: pingUsers ? ["users"] : [] } }),
  });
  await ensureOk(res, "메시지 전송");
  return ((await res.json()) as any).id;
}

// ── 달레UI 주간 업데이트 헬퍼 ──────────────────────────────────────

/** 역할 멘션까지 알림이 가도록 허용할 멘션 종류 */
const MENTION_ALL = { parse: ["users", "roles"] };

/**
 * 채널 메시지에서 스레드를 시작한다. 생성된 스레드 ID는 시작 메시지 ID와 같다.
 * autoArchiveDuration 단위는 분(1440=1일, 4320=3일, 10080=7일).
 */
export async function createThread(
  channelId: string,
  messageId: string,
  name: string,
  token: string,
  autoArchiveDuration = 4320,
): Promise<string> {
  const res = await fetch(
    `${API}/channels/${channelId}/messages/${messageId}/threads`,
    {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ name, auto_archive_duration: autoArchiveDuration }),
    },
  );
  await ensureOk(res, "스레드 생성");
  return ((await res.json()) as any).id;
}

/**
 * 역할 멘션이 포함된 메시지 게시. 스레드 시작 메시지처럼
 * 역할 전체에 알림을 보내야 하는 경우에만 쓴다.
 */
export async function postMessageWithRoleMention(
  channelId: string,
  content: string,
  token: string,
): Promise<string> {
  const res = await fetch(`${API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: MENTION_ALL }),
  });
  await ensureOk(res, "역할 멘션 메시지 전송");
  return ((await res.json()) as any).id;
}

export interface ChannelMessage {
  id: string;
  authorId: string;
  authorName: string;
  isBot: boolean;
  content: string;
  createdMs: number;
}

/** 채널 또는 스레드의 최근 메시지 (최신순으로 최대 limit개). */
export async function listMessages(
  channelId: string,
  token: string,
  limit = 50,
): Promise<ChannelMessage[]> {
  const url = new URL(`${API}/channels/${channelId}/messages`);
  url.searchParams.set("limit", String(Math.min(limit, 100)));

  const res = await fetch(url, { headers: authHeaders(token) });
  await ensureOk(res, "채널 메시지 조회");

  return ((await res.json()) as any[]).map((m) => ({
    id: m.id,
    authorId: m.author?.id ?? "",
    authorName: m.author?.username ?? "unknown",
    isBot: Boolean(m.author?.bot),
    content: m.content ?? "",
    createdMs: snowflakeToMs(m.id),
  }));
}

/** Discord 메시지 하나에 들어갈 수 있는 최대 글자 수 */
export const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * Discord 메시지 길이 제한에 맞춰 나눈다. H3 헤더(\`### \`) 경계에서만 자르므로
 * 한 섹션이 두 메시지에 걸치지 않는다.
 * 한 블록이 그 자체로 제한을 넘으면 줄 단위로 마저 나눈다.
 */
export function splitForDiscord(text: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
  const blocks: string[] = [];
  let current: string[] = [];

  for (const line of text.split("\n")) {
    if (line.startsWith("### ") && current.length > 0) {
      blocks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current.join("\n"));

  const messages: string[] = [];
  let buffer = "";

  const flush = () => {
    if (buffer.trim()) messages.push(buffer.trim());
    buffer = "";
  };

  for (const block of blocks) {
    if (block.length > limit) {
      flush();
      messages.push(...splitByLine(block, limit));
      continue;
    }
    if (buffer.length + block.length + 1 > limit) flush();
    buffer = buffer ? `${buffer}\n${block}` : block;
  }
  flush();

  return messages;
}

/** 헤더 경계로도 안 되는 큰 덩어리를 줄 단위로 쪼갠다. */
function splitByLine(block: string, limit: number): string[] {
  const out: string[] = [];
  let buffer = "";

  for (const line of block.split("\n")) {
    for (const piece of chunkLine(line, limit)) {
      if (buffer.length + piece.length + 1 > limit) {
        if (buffer.trim()) out.push(buffer.trim());
        buffer = piece;
      } else {
        buffer = buffer ? `${buffer}\n${piece}` : piece;
      }
    }
  }
  if (buffer.trim()) out.push(buffer.trim());

  return out;
}

/** 제한보다 긴 한 줄은 버리지 않고 제한 크기로 마저 나눈다. */
function chunkLine(line: string, limit: number): string[] {
  if (line.length <= limit) return [line];

  const pieces: string[] = [];
  for (let i = 0; i < line.length; i += limit) pieces.push(line.slice(i, i + limit));

  return pieces;
}
