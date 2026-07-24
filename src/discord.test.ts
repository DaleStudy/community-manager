import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { webcrypto } from "node:crypto";
import { newestThreadUnderParent, verifySignature } from "./discord.js";

beforeAll(() => {
  vi.stubGlobal("crypto", webcrypto);
});

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
}

async function sign(privateKey: CryptoKey, timestamp: string, body: string): Promise<string> {
  const message = new TextEncoder().encode(timestamp + body);
  const signature = await crypto.subtle.sign("Ed25519", privateKey, message);
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function exportPublicKeyHex(publicKey: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", publicKey) as ArrayBuffer;
  return Array.from(new Uint8Array(raw))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("verifySignature", () => {
  it("올바른 서명이면 true를 반환한다", async () => {
    const { privateKey, publicKey } = await generateKeyPair();
    const publicKeyHex = await exportPublicKeyHex(publicKey);
    const timestamp = "1700000000";
    const body = '{"type":1}';
    const signature = await sign(privateKey, timestamp, body);

    const result = await verifySignature(publicKeyHex, signature, timestamp, body);
    expect(result).toBe(true);
  });

  it("서명이 잘못된 경우 false를 반환한다", async () => {
    const { publicKey } = await generateKeyPair();
    const publicKeyHex = await exportPublicKeyHex(publicKey);

    const result = await verifySignature(
      publicKeyHex,
      "a".repeat(128),
      "1700000000",
      '{"type":1}',
    );
    expect(result).toBe(false);
  });

  it("body가 다르면 false를 반환한다", async () => {
    const { privateKey, publicKey } = await generateKeyPair();
    const publicKeyHex = await exportPublicKeyHex(publicKey);
    const timestamp = "1700000000";
    const signature = await sign(privateKey, timestamp, '{"type":1}');

    const result = await verifySignature(publicKeyHex, signature, timestamp, '{"type":2}');
    expect(result).toBe(false);
  });

  it("timestamp가 다르면 false를 반환한다", async () => {
    const { privateKey, publicKey } = await generateKeyPair();
    const publicKeyHex = await exportPublicKeyHex(publicKey);
    const body = '{"type":1}';
    const signature = await sign(privateKey, "1700000000", body);

    const result = await verifySignature(publicKeyHex, signature, "9999999999", body);
    expect(result).toBe(false);
  });
});

describe("newestThreadUnderParent", () => {
  const BOT = "bot-1";
  const CH = "channel-1";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stubFetch(activeThreads: unknown[], archivedThreads: unknown[] = []): void {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/threads/active")) {
        return Response.json({ threads: activeThreads });
      }
      if (url.includes("/threads/archived/public")) {
        return Response.json({ threads: archivedThreads, has_more: false });
      }
      throw new Error(`예상치 못한 요청: ${url}`);
    });
  }

  it("멤버가 만든 더 새로운 스레드를 무시하고 봇이 만든 최신 스레드를 고른다", async () => {
    stubFetch([
      { id: "300", parent_id: CH, type: 11, owner_id: "user-1" },
      { id: "200", parent_id: CH, type: 11, owner_id: BOT },
      { id: "100", parent_id: CH, type: 11, owner_id: BOT },
    ]);

    expect(await newestThreadUnderParent("guild-1", CH, BOT, "token")).toBe("200");
  });

  it("다른 채널에 있는 봇 스레드는 고려하지 않는다", async () => {
    stubFetch([
      { id: "300", parent_id: "other-channel", type: 11, owner_id: BOT },
      { id: "200", parent_id: CH, type: 11, owner_id: BOT },
    ]);

    expect(await newestThreadUnderParent("guild-1", CH, BOT, "token")).toBe("200");
  });

  it("보관된 봇 스레드도 후보에 포함한다", async () => {
    stubFetch(
      [{ id: "100", parent_id: CH, type: 11, owner_id: BOT }],
      [{ id: "200", parent_id: CH, type: 11, owner_id: BOT }],
    );

    expect(await newestThreadUnderParent("guild-1", CH, BOT, "token")).toBe("200");
  });

  it("봇이 만든 스레드가 없으면 null을 반환한다", async () => {
    stubFetch([{ id: "300", parent_id: CH, type: 11, owner_id: "user-1" }]);

    expect(await newestThreadUnderParent("guild-1", CH, BOT, "token")).toBe(null);
  });
});
