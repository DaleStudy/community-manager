import { describe, it, expect, vi, beforeAll } from "vitest";
import { webcrypto } from "node:crypto";
import { verifySignature } from "./discord.js";

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
