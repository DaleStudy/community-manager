import { describe, expect, it } from "vitest";
import { buildThreadName, classify, computeWeekWindow } from "./blog.js";

// 2026-06-29 09:00 KST = 2026-06-29 00:00 UTC (cron "0 0 * * MON" 발화 시각)
const REF = Date.parse("2026-06-29T00:00:00Z");
const w = computeWeekWindow(REF);

describe("computeWeekWindow", () => {
  it("이번주 월 09:00 KST = 2026-06-29 00:00 UTC", () => {
    expect(new Date(w.thisMonday9Utc).toISOString()).toBe("2026-06-29T00:00:00.000Z");
  });
  it("이번주 월 00:00 KST = 2026-06-28 15:00 UTC", () => {
    expect(new Date(w.thisMondayMidnightUtc).toISOString()).toBe("2026-06-28T15:00:00.000Z");
  });
  it("지난주 월 09:00 KST = 2026-06-22 00:00 UTC", () => {
    expect(new Date(w.lastMonday9Utc).toISOString()).toBe("2026-06-22T00:00:00.000Z");
  });
});

describe("classify", () => {
  it("미작성 → warn(경고)", () => {
    expect(classify(undefined, w)).toBe("warn");
  });
  it("이번주 월 00:00(KST) 이전 작성 → normal(정상)", () => {
    // 2026-06-28 22:00 KST
    expect(classify(Date.parse("2026-06-28T13:00:00Z"), w)).toBe("normal");
  });
  it("이번주 월 00:00~09:00(KST) 사이 첫 작성 → late(지각)", () => {
    // 2026-06-29 05:00 KST — 라이브로는 재현 못 했던 경로
    expect(classify(Date.parse("2026-06-28T20:00:00Z"), w)).toBe("late");
  });
  it("이번주 월 09:00(KST) 이후 작성 → warn(경고)", () => {
    // 2026-06-29 10:00 KST
    expect(classify(Date.parse("2026-06-29T01:00:00Z"), w)).toBe("warn");
  });
});

describe("buildThreadName", () => {
  it("블로그 06/29 - 07/05", () => {
    expect(buildThreadName(REF)).toBe("블로그 06/29 - 07/05");
  });
});
