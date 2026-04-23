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
 * Discord 채널 메시지 조회
 */
export async function getChannelMessages(
  channelId: string,
  botToken: string,
  limit: number = 50,
): Promise<any[]> {
  const response = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages?limit=${limit}`,
    {
      headers: {
        Authorization: `Bot ${botToken}`,
      },
    },
  );

  if (!response.ok) {
    const data = await response.json() as any;
    throw new Error(`Failed to get channel messages: ${JSON.stringify(data)}`);
  }

  return response.json() as Promise<any[]>;
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
