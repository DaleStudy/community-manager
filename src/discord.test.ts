import { describe, it, expect, vi, beforeAll } from "vitest";
import { webcrypto } from "node:crypto";
import {
  DISCORD_MESSAGE_LIMIT,
  listMembersWithRoles,
  snowflakeToMs,
  splitForDiscord,
  verifySignature,
} from "./discord.js";

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

describe("splitForDiscord", () => {
  it("제한 안에 들어가면 한 개", () => {
    expect(splitForDiscord("짧은 요약")).toEqual(["짧은 요약"]);
  });

  it("H3 헤더 경계에서만 자른다 — 한 사람의 요약이 두 메시지에 걸치지 않는다", () => {
    const member = (id: string) => `### <@${id}>\n${"- 어떤 기여 항목\n".repeat(30)}`;
    const text = [member("1"), member("2"), member("3")].join("\n");

    const chunks = splitForDiscord(text, 900);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(900);
      // 각 조각은 헤더로 시작하고, 조각 안의 헤더 수만큼만 멤버를 담는다
      expect(chunk.startsWith("### ")).toBe(true);
    }
    // 멤버가 유실되지 않는다
    const joined = chunks.join("\n");
    for (const id of ["1", "2", "3"]) {
      expect(joined).toContain(`### <@${id}>`);
    }
  });

  it("머리말은 첫 헤더 앞에 그대로 남는다", () => {
    const text = "📋 안내 문구\n-# 범례\n### <@1>\n- 항목";
    expect(splitForDiscord(text)[0].startsWith("📋 안내 문구")).toBe(true);
  });

  it("한 블록이 제한을 넘으면 줄 단위로 마저 나눈다", () => {
    const text = `### <@1>\n${"- 아주 긴 항목입니다\n".repeat(300)}`;
    const chunks = splitForDiscord(text, 500);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(500);
    }
  });

  it("한 줄이 통째로 제한을 넘어도 뒷부분을 버리지 않는다", () => {
    const longLine = `- ${"가".repeat(1200)}`;

    const chunks = splitForDiscord(`### <@1>\n${longLine}`, 500);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(500);
    }
    expect(chunks.join("")).toContain(longLine);
  });

  it("기본 제한은 Discord 메시지 상한", () => {
    const text = `### <@1>\n${"- 항목\n".repeat(2000)}`;
    for (const chunk of splitForDiscord(text)) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    }
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
