import { describe, expect, it } from "vitest";
import {
  buildContext,
  buildThreadName,
  buildThreadStarter,
  computeWindow,
  formatPeriod,
  parseMembers,
  reconcileMembers,
} from "./daleui.js";

// 2026-08-01 08:00 KST = 2026-07-31 23:00 UTC (cron "0 23 * * FRI" 발화 시각)
const REF = Date.parse("2026-07-31T23:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

describe("parseMembers", () => {
  it("JSON 배열을 멤버 목록으로 파싱한다", () => {
    const members = parseMembers('[{"discordId":"1","github":"a"},{"discordId":"2","github":"b"}]');
    expect(members).toEqual([
      { discordId: "1", github: "a" },
      { discordId: "2", github: "b" },
    ]);
  });

  it("배열이 아니면 오류", () => {
    expect(() => parseMembers('{"discordId":"1"}')).toThrow();
  });
});

describe("computeWindow", () => {
  it("실행 시각 기준 최근 7일", () => {
    expect(computeWindow(REF)).toEqual({ startMs: REF - 7 * DAY_MS, endMs: REF });
  });
});

describe("formatPeriod", () => {
  it("KST 기준 M/D~M/D", () => {
    // 2026-07-25 08:00 KST ~ 2026-08-01 08:00 KST
    expect(formatPeriod(REF - 7 * DAY_MS, REF)).toBe("7/25~8/1");
  });
});

describe("reconcileMembers", () => {
  const mapped = [
    { discordId: "1", github: "alice" },
    { discordId: "2", github: "bob" },
  ];

  it("역할 멤버 순서대로 매핑을 붙인다", () => {
    expect(reconcileMembers(["2", "1"], mapped)).toEqual([
      { discordId: "2", github: "bob" },
      { discordId: "1", github: "alice" },
    ]);
  });

  it("매핑에 없는 신규 멤버도 빠뜨리지 않는다", () => {
    expect(reconcileMembers(["1", "99"], mapped)).toEqual([
      { discordId: "1", github: "alice" },
      { discordId: "99", github: "" },
    ]);
  });

  it("역할에서 빠진 멤버는 제외한다", () => {
    expect(reconcileMembers(["1"], mapped)).toEqual([{ discordId: "1", github: "alice" }]);
  });
});

describe("buildThreadStarter", () => {
  it("역할 멘션을 한 번만 넣는다", () => {
    const starter = buildThreadStarter("Sprint 8 종료 회의", "999");
    expect(starter).toContain("<@&999>");
    expect(starter.match(/<@&/g)).toHaveLength(1);
    expect(starter).toContain("Sprint 8 종료 회의");
  });
});

describe("buildThreadName", () => {
  it("Discord 스레드 이름 제한(100자)을 넘지 않는다", () => {
    expect(buildThreadName("긴 회의 제목".repeat(50)).length).toBeLessThanOrEqual(100);
  });
});

describe("buildContext", () => {
  const base = {
    members: [{ discordId: "1", github: "alice" }],
    meetingTitle: "Sprint 8 종료 회의",
    period: "7/25~8/1",
    activity: [],
    comments: [],
    board: [],
    discordMessages: [],
  };

  it("수집된 게 없어도 각 구획을 (없음)으로 남긴다", () => {
    const context = buildContext(base);
    expect(context).toContain("Sprint 8 종료 회의");
    expect(context).toContain("7/25~8/1");
    expect(context.match(/\(없음\)/g)).toHaveLength(4);
  });

  it("매핑이 없는 멤버는 그렇게 표시한다", () => {
    const context = buildContext({ ...base, members: [{ discordId: "9", github: "" }] });
    expect(context).toContain("(GitHub 핸들 미확인)");
  });

  it("PR 병합 여부와 담당자를 남긴다", () => {
    const context = buildContext({
      ...base,
      activity: [
        {
          repo: "daleui",
          number: 1225,
          title: "아이콘 5종 추가",
          url: "https://github.com/DaleStudy/daleui/pull/1225",
          state: "closed",
          author: "DaleSeo",
          assignees: ["DaleSeo"],
          labels: [],
          createdAt: "2026-07-30T00:39:00Z",
          updatedAt: "2026-07-30T01:00:00Z",
          isPullRequest: true,
          mergedAt: "2026-07-30T01:00:00Z",
        },
      ],
    });
    expect(context).toContain("PR #1225");
    expect(context).toContain("병합됨");
    expect(context).toContain("담당:DaleSeo");
  });
});
