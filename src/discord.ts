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
