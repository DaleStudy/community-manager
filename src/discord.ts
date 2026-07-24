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

// NEWS(10) / PUBLIC(11) / PRIVATE(12) 스레드
const THREAD_TYPES = new Set([10, 11, 12]);

/** 봇 자신의 사용자 ID — 봇이 만든 스레드를 가려낼 때 쓴다. */
export async function getBotUserId(token: string): Promise<string> {
  const res = await fetch(`${API}/users/@me`, { headers: authHeaders(token) });
  await ensureOk(res, "봇 사용자 조회");
  const me = (await res.json()) as any;
  return me.id as string;
}

/**
 * 부모 채널 아래 ownerId가 만든 스레드 중 가장 최근에 생성된(스레드 ID 최대) 것의 ID.
 * 멤버가 임의로 만든 스레드가 주간 스레드를 가로채지 않도록 소유자를 제한한다.
 * 활성 스레드(길드) + 보관된 공개 스레드(채널)를 모두 본다.
 * 스레드 ID는 snowflake(64bit)라 BigInt로 비교한다.
 */
export async function newestThreadUnderParent(
  guildId: string,
  channelId: string,
  ownerId: string,
  token: string,
): Promise<string | null> {
  const headers = authHeaders(token);
  let best: bigint | null = null;
  const consider = (t: any) => {
    if (t.owner_id !== ownerId || !THREAD_TYPES.has(t.type)) return;
    const v = BigInt(t.id);
    if (best === null || v > best) best = v;
  };

  // 활성 스레드
  const activeRes = await fetch(`${API}/guilds/${guildId}/threads/active`, { headers });
  await ensureOk(activeRes, "활성 스레드 조회");
  const active = (await activeRes.json()) as any;
  for (const t of active.threads ?? []) {
    if (t.parent_id === channelId) consider(t);
  }

  // 보관된 공개 스레드 (archive_timestamp 기준 페이지네이션)
  let before: string | undefined;
  while (true) {
    const url = new URL(`${API}/channels/${channelId}/threads/archived/public`);
    url.searchParams.set("limit", "100");
    if (before) url.searchParams.set("before", before);
    const res = await fetch(url, { headers });
    await ensureOk(res, "보관 스레드 조회");
    const page = (await res.json()) as any;
    const threads: any[] = page.threads ?? [];
    if (threads.length === 0) break;
    for (const t of threads) consider(t);
    if (!page.has_more) break;
    before = threads[threads.length - 1]?.thread_metadata?.archive_timestamp;
    if (!before) break;
  }

  return best === null ? null : best.toString();
}

/**
 * 스레드 메시지를 [lastMonday9, thisMonday9] 창에서 읽어
 * 각 사람(비봇)의 "첫(최소) 메시지 시각(ms)"을 수집한다.
 * Discord 메시지 목록은 최신순이라, 창보다 과거에 도달하면 중단한다.
 */
export async function collectFirstMessageTimes(
  threadId: string,
  token: string,
  lastMonday9Ms: number,
  thisMonday9Ms: number,
): Promise<Map<string, number>> {
  const headers = authHeaders(token);
  const firstByUser = new Map<string, number>();
  let before: string | undefined;

  outer: while (true) {
    const url = new URL(`${API}/channels/${threadId}/messages`);
    url.searchParams.set("limit", "100");
    if (before) url.searchParams.set("before", before);
    const res = await fetch(url, { headers });
    await ensureOk(res, "스레드 메시지 조회");
    const messages = (await res.json()) as any[];
    if (messages.length === 0) break;

    for (const msg of messages) {
      const ts = Date.parse(msg.timestamp);
      if (ts < lastMonday9Ms) break outer; // 창보다 과거 → 종료
      if (ts > thisMonday9Ms) continue; // 창보다 미래 → 무시
      if (msg.author?.bot) continue;
      const uid = msg.author.id as string;
      const prev = firstByUser.get(uid);
      if (prev === undefined || ts < prev) firstByUser.set(uid, ts);
    }

    before = messages[messages.length - 1].id; // 이 페이지에서 가장 오래된 메시지
  }

  return firstByUser;
}

/**
 * 특정 역할을 가진 사람(비봇) ID 목록 — 페이지네이션.
 * ⚠️ GET /guilds/{id}/members 는 GUILD_MEMBERS(privileged) 인텐트가 켜져 있어야 동작한다.
 */
export async function listRoleMembers(
  guildId: string,
  roleId: string,
  token: string,
): Promise<string[]> {
  const headers = authHeaders(token);
  const ids: string[] = [];
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
      if (!m.user?.bot && (m.roles ?? []).includes(roleId)) ids.push(m.user.id);
    }
    after = members[members.length - 1].user.id;
    if (members.length < 1000) break;
  }

  return ids;
}

/** 채널에 텍스트 메시지 게시 (멘션 핑 허용) */
export async function postMessage(channelId: string, content: string, token: string): Promise<void> {
  const res = await fetch(`${API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { parse: ["users"] } }),
  });
  await ensureOk(res, "메시지 전송");
}

/** 채널에 공개 스레드 생성 (메시지 없이, 7일 보관) */
export async function createPublicThread(
  channelId: string,
  name: string,
  token: string,
): Promise<void> {
  const res = await fetch(`${API}/channels/${channelId}/threads`, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ name, type: 11, auto_archive_duration: 10080 }),
  });
  await ensureOk(res, "스레드 생성");
}
