import { describe, it, expect, vi, beforeAll } from "vitest";
import { webcrypto } from "node:crypto";
import { listMembersWithRoles, snowflakeToMs, verifySignature } from "./discord.js";

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

describe("snowflakeToMs", () => {
  it("운영 봇 메시지 ID의 생성 시각과 일치한다", () => {
    // DaleStudy 봇의 "블로그 07/13 - 07/19" 메시지 — Discord timestamp: 2026-07-13T00:00:57.267Z
    expect(new Date(snowflakeToMs("1526015542237069445")).toISOString()).toBe(
      "2026-07-13T00:00:57.267Z",
    );
  });
});

describe("listMembersWithRoles", () => {
  it("역할 중 하나라도 가진 비봇 멤버를 이름 후보와 함께 돌려준다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { user: { id: "1", username: "alice", global_name: "Alice Kim" }, nick: null, roles: ["cohort"] },
          { user: { id: "2", username: "bob", global_name: null }, nick: "bobby", roles: ["coach"] },
          { user: { id: "3", username: "carol" }, roles: ["other"] },
          { user: { id: "4", username: "dalestudy", bot: true }, roles: ["cohort"] },
        ],
      }),
    );

    const members = await listMembersWithRoles("guild", ["cohort", "coach"], "test-token");

    expect(members).toEqual([
      { id: "1", names: ["alice", "Alice Kim"], roles: ["cohort"] },
      { id: "2", names: ["bob", "bobby"], roles: ["coach"] },
    ]);
  });
});
