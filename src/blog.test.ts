import { describe, expect, it } from "vitest";
import {
  buildRankingReport,
  buildWeekRange,
  classify,
  computeWeekWindow,
  firstPostTimes,
  rankPosts,
  type Post,
} from "./blog.js";

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
  it("미게시 → warn(경고)", () => {
    expect(classify(undefined, w)).toBe("warn");
  });
  it("이번주 월 00:00(KST) 이전 게시 → normal(정상)", () => {
    // 2026-06-28 22:00 KST
    expect(classify(Date.parse("2026-06-28T13:00:00Z"), w)).toBe("normal");
  });
  it("이번주 월 00:00~09:00(KST) 사이 첫 게시 → late(지각)", () => {
    // 2026-06-29 05:00 KST — 라이브로는 재현 못 했던 경로
    expect(classify(Date.parse("2026-06-28T20:00:00Z"), w)).toBe("late");
  });
  it("이번주 월 09:00(KST) 이후 게시 → warn(경고)", () => {
    // 2026-06-29 10:00 KST
    expect(classify(Date.parse("2026-06-29T01:00:00Z"), w)).toBe("warn");
  });
});

describe("buildWeekRange", () => {
  it("06/29 - 07/05", () => {
    expect(buildWeekRange(REF)).toBe("06/29 - 07/05");
  });
});

function post(overrides: Partial<Post> & Pick<Post, "threadId">): Post {
  return { ownerId: "u1", reactors: 0, comments: 0, createdMs: 0, ...overrides };
}

describe("firstPostTimes", () => {
  it("한 사람이 여러 글을 올리면 가장 이른 시각을 남긴다", () => {
    const times = firstPostTimes([
      { ownerId: "u1", createdMs: 300 },
      { ownerId: "u1", createdMs: 100 },
      { ownerId: "u2", createdMs: 200 },
    ]);
    expect(times.get("u1")).toBe(100);
    expect(times.get("u2")).toBe(200);
  });

  it("글이 없는 사람은 담기지 않는다", () => {
    expect(firstPostTimes([]).get("u1")).toBeUndefined();
  });
});

describe("rankPosts", () => {
  it("댓글 1개는 반응 3개와 같은 점수다", () => {
    const [a, b] = rankPosts([
      post({ threadId: "a", comments: 1 }),
      post({ threadId: "b", reactors: 3 }),
    ]);
    expect(a.score).toBe(3);
    expect(b.score).toBe(3);
  });

  it("점수가 높은 글이 앞선다 — 반응 7 + 댓글 6 = 25점", () => {
    const ranked = rankPosts([
      post({ threadId: "bigquery", reactors: 4 }),
      post({ threadId: "error-handling", reactors: 7, comments: 6 }),
      post({ threadId: "closure", reactors: 3 }),
    ]);
    expect(ranked.map((p) => p.threadId)).toEqual(["error-handling", "bigquery", "closure"]);
    expect(ranked[0].score).toBe(25);
  });

  it("동점이면 반응자가 많은 글이 앞선다", () => {
    const ranked = rankPosts([
      post({ threadId: "comments", comments: 2 }),
      post({ threadId: "reactions", reactors: 6 }),
    ]);
    expect(ranked.map((p) => p.threadId)).toEqual(["reactions", "comments"]);
  });

  it("점수와 반응자가 모두 같으면 먼저 올라온 글이 앞선다", () => {
    const ranked = rankPosts([
      post({ threadId: "late", reactors: 3, createdMs: 200 }),
      post({ threadId: "early", reactors: 3, createdMs: 100 }),
    ]);
    expect(ranked.map((p) => p.threadId)).toEqual(["early", "late"]);
  });
});

describe("buildRankingReport", () => {
  const ranked = rankPosts([
    post({ threadId: "t1", ownerId: "u1", reactors: 7, comments: 6 }),
    post({ threadId: "t2", ownerId: "u2", reactors: 4 }),
    post({ threadId: "t3", ownerId: "u3", reactors: 3 }),
    post({ threadId: "t4", ownerId: "u4", reactors: 2 }),
  ]);

  it("상위 3개에 메달을 달고 나머지는 순번을 붙인다", () => {
    const report = buildRankingReport(ranked, 5, REF);
    expect(report).toContain("🥇 <#t1> — <@u1>");
    expect(report).toContain("🥈 <#t2> — <@u2>");
    expect(report).toContain("🥉 <#t3> — <@u3>");
    expect(report).toContain("`4위` <#t4> — <@u4>");
  });

  it("반응·댓글 내역과 점수를 함께 보여준다", () => {
    expect(buildRankingReport(ranked, 5, REF)).toContain("추천 7 · 댓글 6 → **25점**");
  });

  it("집계 대상은 이번 주가 아니라 지난 주다", () => {
    // REF(06/29 09:00 KST)에 도는 cron이 집계하는 창은 06/22 ~ 06/28
    expect(buildRankingReport(ranked, 5, REF)).toContain("블로그 06/22 - 06/28 순위");
  });

  it("topN을 넘는 글은 잘라낸다", () => {
    expect(buildRankingReport(ranked, 3, REF)).not.toContain("<#t4>");
  });

  it("추천도 댓글도 없는 글은 순위에서 뺀다", () => {
    const report = buildRankingReport(rankPosts([post({ threadId: "quiet" })]), 5, REF);
    expect(report).toContain("추천이나 댓글을 받은 글이 없어");
    expect(report).not.toContain("<#quiet>");
  });
});
