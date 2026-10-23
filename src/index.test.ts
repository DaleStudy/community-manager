import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityItem, CommentItem } from "./github.js";
import type { Env } from "./types.js";
import worker, { collectReviewPraise } from "./index.js";
import { getInstallationToken, getReviewAssignments, listRecentComments, listRecentIssuesAndPulls } from "./github.js";
import { createThread, listMembersWithRoles, postMessage, postMessageWithRoleMention, splitForDiscord } from "./discord.js";
import { generateSummary } from "./claude.js";

vi.mock("./github.js");
vi.mock("./discord.js");
vi.mock("./claude.js");

// 2026-11-09 09:00 KST = 2026-11-09 00:00 UTC (cron "0 0 * * MON" 발화 시각, 9기 1주차 직후)
const REF = Date.parse("2026-11-09T00:00:00Z");

const env = {
  GITHUB_ORG: "DaleStudy",
  DISCORD_TOKEN: "discord-token",
  DISCORD_GUILD_ID: "guild",
  LEETCODE_CHANNEL_ID: "leetcode-channel",
  COACH_ROLE_ID: "coach-role",
  AI_GATEWAY_TOKEN: "gateway-token",
  // 마지막 항목이 현재 진행 중인 기수다.
  ROLE_TEAM_CONFIG: JSON.stringify([
    { value: "leetcode08", label: "8기", discordRoleId: "role-8", teamSlug: "leetcode08" },
    { value: "leetcode09", label: "9기", discordRoleId: "role-9", teamSlug: "leetcode09" },
  ]),
} as unknown as Env;

function pr(number: number, author: string, overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    repo: "leetcode-study",
    number,
    title: `[${author}] WEEK 01 Solutions`,
    url: `https://github.com/DaleStudy/leetcode-study/pull/${number}`,
    state: "closed",
    author,
    assignees: [],
    labels: [],
    createdAt: "2026-11-03T00:00:00Z",
    updatedAt: "2026-11-08T00:00:00Z",
    isPullRequest: true,
    mergedAt: "2026-11-08T00:00:00Z",
    ...overrides,
  };
}

function comment(id: number, number: number, author: string, createdAt: string): CommentItem {
  return {
    id,
    inReplyTo: null,
    repo: "leetcode-study",
    number,
    author,
    body: `${author}의 리뷰`,
    url: `https://github.com/DaleStudy/leetcode-study/pull/${number}#discussion_r${id}`,
    createdAt,
    isReviewComment: true,
  };
}

function scheduledEvent(cron: string, scheduledTime: number): ScheduledEvent {
  return { cron, scheduledTime } as ScheduledEvent;
}

/** waitUntil 에 넘긴 작업을 모아 두었다가 테스트에서 끝날 때까지 기다린다. */
function fakeContext() {
  const tasks: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as unknown as ExecutionContext;
  return { ctx, settle: () => Promise.allSettled(tasks) };
}

beforeEach(async () => {
  vi.mocked(getInstallationToken).mockResolvedValue("gh-token");
  vi.mocked(getReviewAssignments).mockResolvedValue(new Map());
  vi.mocked(listMembersWithRoles).mockResolvedValue([]);
  vi.mocked(listRecentComments).mockResolvedValue([]);
  vi.mocked(generateSummary).mockResolvedValue("### 이번 주 리뷰\n좋은 리뷰가 많았어요.");
  vi.mocked(postMessageWithRoleMention).mockResolvedValue("starter-id");
  vi.mocked(createThread).mockResolvedValue("thread-id");
  // 메시지 분할은 순수 함수라 실제 구현을 쓴다.
  const actual = await vi.importActual<typeof import("./discord.js")>("./discord.js");
  vi.mocked(splitForDiscord).mockImplementation(actual.splitForDiscord);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("collectReviewPraise", () => {
  it("기수 사이처럼 최근 병합된 풀이 PR이 없으면 null", async () => {
    vi.mocked(listRecentIssuesAndPulls).mockResolvedValue([]);
    expect(await collectReviewPraise(env, REF)).toBeNull();
  });

  it("기준 시각 뒤에 열린 PR과 달린 코멘트는 집계에서 뺀다", async () => {
    vi.mocked(listRecentIssuesAndPulls).mockResolvedValue([
      pr(1, "alice"),
      // 다음 기수의 같은 주차 PR
      pr(2, "carol", { createdAt: "2027-02-02T00:00:00Z", mergedAt: "2027-02-07T00:00:00Z" }),
    ]);
    vi.mocked(listRecentComments).mockResolvedValue([
      comment(10, 1, "bob", "2026-11-05T00:00:00Z"),
      comment(11, 1, "dave", "2026-11-20T00:00:00Z"),
    ]);

    const collection = await collectReviewPraise(env, REF);

    expect(collection?.week).toBe(1);
    expect(collection?.prCount).toBe(1);
    expect(collection?.context).toContain("bob");
    expect(collection?.context).not.toContain("dave");
  });
});

describe("월요일 cron 의 모범 리뷰 칭찬", () => {
  it("현재 기수 역할은 시작 메시지에서 한 번만 멘션하고, 본문은 스레드에 올린다", async () => {
    vi.mocked(listRecentIssuesAndPulls).mockResolvedValue([pr(1, "alice")]);
    const { ctx, settle } = fakeContext();

    await worker.scheduled(scheduledEvent("0 0 * * MON", REF), env, ctx);
    await settle();

    expect(postMessageWithRoleMention).toHaveBeenCalledTimes(1);
    const [channelId, starter] = vi.mocked(postMessageWithRoleMention).mock.calls[0];
    expect(channelId).toBe("leetcode-channel");
    expect(starter).toContain("<@&role-9>");
    expect(starter).not.toContain("<@&role-8>");

    expect(createThread).toHaveBeenCalledWith(
      "leetcode-channel",
      "starter-id",
      expect.stringContaining("WEEK 1"),
      "discord-token",
    );
    expect(postMessage).toHaveBeenCalled();
    for (const [target, content] of vi.mocked(postMessage).mock.calls) {
      expect(target).toBe("thread-id");
      expect(content).not.toContain("<@&");
    }
  });

  it("기수 사이에는 아무것도 게시하지 않는다", async () => {
    vi.mocked(listRecentIssuesAndPulls).mockResolvedValue([]);
    const { ctx, settle } = fakeContext();

    await worker.scheduled(scheduledEvent("0 0 * * MON", REF), env, ctx);
    await settle();

    expect(generateSummary).not.toHaveBeenCalled();
    expect(postMessageWithRoleMention).not.toHaveBeenCalled();
    expect(createThread).not.toHaveBeenCalled();
  });
});
