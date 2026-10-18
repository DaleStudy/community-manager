import { describe, expect, it } from "vitest";
import type { ActivityItem, CommentItem, ReviewAssignment } from "./github.js";
import type { GuildMember } from "./discord.js";
import {
  aggregateReviews,
  buildMentions,
  buildPraiseContext,
  buildPraiseStarter,
  buildPraiseThreadName,
  isBot,
  matchMember,
  parseWeek,
  pickTargetWeek,
  selectWeekPrs,
} from "./praise.js";

// 2026-11-09 09:00 KST = 2026-11-09 00:00 UTC (cron "0 0 * * MON" 발화 시각, 9기 1주차 직후)
const REF = Date.parse("2026-11-09T00:00:00Z");

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

let nextId = 1;
function comment(
  number: number,
  author: string,
  overrides: Partial<CommentItem> = {},
): CommentItem {
  const id = nextId++;
  return {
    id,
    inReplyTo: null,
    repo: "leetcode-study",
    number,
    author,
    body: `${author}의 코멘트`,
    url: `https://github.com/DaleStudy/leetcode-study/pull/${number}#discussion_r${id}`,
    createdAt: `2026-11-05T00:00:${String(id % 60).padStart(2, "0")}Z`,
    isReviewComment: true,
    ...overrides,
  };
}

/** root 댓글에 이어지는 답글들. 작성 순서대로 시각이 늘어난다. */
function thread(number: number, authors: string[]): CommentItem[] {
  const root = comment(number, authors[0], { createdAt: "2026-11-05T01:00:00Z" });
  return [
    root,
    ...authors.slice(1).map((a, i) =>
      comment(number, a, {
        inReplyTo: root.id,
        createdAt: `2026-11-05T01:0${i + 1}:00Z`,
      }),
    ),
  ];
}

function member(id: string, names: string[], roles: string[] = ["cohort"]): GuildMember {
  return { id, names, roles };
}

const noCoach = () => false;

describe("parseWeek", () => {
  it("풀이 PR 제목에서 주차를 읽는다", () => {
    expect(parseWeek("[alice] WEEK 03 Solutions")).toBe(3);
    expect(parseWeek("[bob] Week 12 solutions")).toBe(12);
  });

  it("풀이 PR 형식이 아니면 null", () => {
    expect(parseWeek("docs: README 9기 추가")).toBeNull();
    expect(parseWeek("WEEK 03 Solutions")).toBeNull();
  });
});

describe("isBot", () => {
  it("[bot] 접미사와 AI 코치 계정을 봇으로 본다", () => {
    expect(isBot("dalestudy[bot]")).toBe(true);
    expect(isBot("dalestudy")).toBe(true);
    expect(isBot("alice")).toBe(false);
  });
});

describe("pickTargetWeek", () => {
  it("최근 7일 안에 병합된 풀이 PR에서 가장 많은 주차를 고른다", () => {
    const items = [
      pr(1, "a"),
      pr(2, "b"),
      // 이미 시작된 다음 주차 PR들은 아직 병합 전이다.
      pr(3, "a", { title: "[a] WEEK 02 Solutions", state: "open", mergedAt: null }),
      pr(4, "b", { title: "[b] WEEK 02 Solutions", state: "open", mergedAt: null }),
      pr(5, "c", { title: "[c] WEEK 02 Solutions", state: "open", mergedAt: null }),
    ];
    expect(pickTargetWeek(items, REF)).toBe(1);
  });

  it("7일보다 전에 병합된 PR은 보지 않는다", () => {
    const items = [pr(1, "a", { mergedAt: "2026-10-30T00:00:00Z" })];
    expect(pickTargetWeek(items, REF)).toBeNull();
  });

  it("기준 시각 이후에 병합된 PR은 보지 않는다 (과거 시점 재생)", () => {
    const items = [
      pr(1, "a"),
      pr(2, "a", { title: "[a] WEEK 02 Solutions", mergedAt: "2026-11-15T00:00:00Z" }),
      pr(3, "b", { title: "[b] WEEK 02 Solutions", mergedAt: "2026-11-15T00:00:00Z" }),
    ];
    expect(pickTargetWeek(items, REF)).toBe(1);
  });

  it("기수 사이처럼 풀이 PR이 없으면 null", () => {
    expect(pickTargetWeek([], REF)).toBeNull();
  });
});

describe("selectWeekPrs", () => {
  it("병합 없이 닫힌 중복 PR과 다른 주차 PR을 뺀다", () => {
    const items = [
      pr(1, "a"),
      pr(2, "b", { mergedAt: null }),
      pr(3, "c", { state: "open", mergedAt: null }),
      pr(4, "d", { title: "[d] WEEK 02 Solutions" }),
    ];
    expect(selectWeekPrs(items, 1).map((p) => p.number)).toEqual([1, 3]);
  });
});

describe("matchMember", () => {
  it("username, 닉네임, 표시 이름 중 하나가 GitHub 아이디와 같으면 찾는다 (대소문자 무시)", () => {
    const members = [member("1", ["alice_d", "Alice"]), member("2", ["bob"])];
    expect(matchMember("alice", members)?.id).toBe("1");
    expect(matchMember("BOB", members)?.id).toBe("2");
    expect(matchMember("carol", members)).toBeUndefined();
  });
});

describe("aggregateReviews", () => {
  it("본인 PR 답글과 봇 코멘트는 리뷰로 세지 않고, 봇 코멘트는 따로 센다", () => {
    const review = aggregateReviews({
      week: 1,
      prs: [pr(1, "alice")],
      comments: [
        comment(1, "bob"),
        comment(1, "alice"),
        comment(1, "dalestudy[bot]"),
        comment(1, "dalestudy", { isReviewComment: false }),
      ],
      assignments: new Map(),
      isCoach: noCoach,
    });

    expect(review.reviewers.map((r) => [r.login, r.comments])).toEqual([["bob", 1]]);
    expect(review.botComments).toBe(2);
  });

  it("코멘트 없이 승인만 한 리뷰도 리뷰한 PR로 센다", () => {
    const review = aggregateReviews({
      week: 1,
      prs: [pr(1, "alice")],
      comments: [],
      assignments: new Map([[1, { requested: ["bob"], reviewers: ["bob", "alice"] }]]),
      isCoach: noCoach,
    });

    expect(review.reviewers).toEqual([
      { login: "bob", group: "member", comments: 0, prs: [1], voluntaryPrs: [] },
    ]);
    expect(review.reviewedPrs).toBe(1);
  });

  it("요청받지 않은 PR에 들어간 리뷰를 자발적 리뷰로 표시한다", () => {
    const assignments = new Map<number, ReviewAssignment>([
      [1, { requested: ["bob"], reviewers: [] }],
      [2, { requested: [], reviewers: [] }],
    ]);
    const review = aggregateReviews({
      week: 1,
      prs: [pr(1, "alice"), pr(2, "carol")],
      comments: [comment(1, "bob"), comment(2, "bob")],
      assignments,
      isCoach: noCoach,
    });

    expect(review.reviewers[0]).toMatchObject({ login: "bob", prs: [1, 2], voluntaryPrs: [2] });
  });

  it("코치와 운영자를 구분하고, 멤버끼리의 커버리지를 따로 계산한다", () => {
    const review = aggregateReviews({
      week: 1,
      prs: [pr(1, "alice"), pr(2, "bob"), pr(3, "carol")],
      comments: [comment(1, "coach1"), comment(2, "DaleSeo"), comment(3, "dave")],
      assignments: new Map(),
      isCoach: (login) => login === "coach1",
    });

    const groups = Object.fromEntries(review.reviewers.map((r) => [r.login, r.group]));
    expect(groups).toEqual({ coach1: "coach", DaleSeo: "operator", dave: "member" });
    expect(review.reviewedPrs).toBe(3);
    expect(review.memberReviewedPrs).toBe(1);
  });

  it("코멘트 수, 리뷰한 PR 수 순으로 정렬한다", () => {
    const review = aggregateReviews({
      week: 1,
      prs: [pr(1, "alice"), pr(2, "bob")],
      comments: [comment(1, "carol"), comment(1, "dave"), comment(2, "dave"), comment(1, "erin")],
      assignments: new Map(),
      isCoach: noCoach,
    });

    expect(review.reviewers.map((r) => r.login)).toEqual(["dave", "carol", "erin"]);
  });

  it("대상 주차가 아닌 PR의 코멘트는 무시한다", () => {
    const review = aggregateReviews({
      week: 1,
      prs: [pr(1, "alice")],
      comments: [comment(99, "bob")],
      assignments: new Map(),
      isCoach: noCoach,
    });

    expect(review.reviewers).toEqual([]);
  });
});

describe("aggregateReviews 모범 리뷰 후보", () => {
  const base = { week: 1, assignments: new Map(), isCoach: noCoach };

  it("리뷰어와 작성자가 왕복한 3건 이상의 대화를 후보로 고른다", () => {
    const dialogue = thread(1, ["bob", "alice", "bob"]);
    const oneWay = thread(1, ["bob", "bob", "bob"]);
    const review = aggregateReviews({
      ...base,
      prs: [pr(1, "alice")],
      comments: [...dialogue, ...oneWay],
    });

    expect(review.relaxedThreads).toBe(false);
    expect(review.threads).toHaveLength(1);
    expect(review.threads[0].comments.map((c) => c.author)).toEqual(["bob", "alice", "bob"]);
  });

  it("왕복 대화가 없으면 질문과 답변 2건짜리까지 넓힌다", () => {
    const review = aggregateReviews({
      ...base,
      prs: [pr(1, "alice")],
      comments: thread(1, ["bob", "alice"]),
    });

    expect(review.relaxedThreads).toBe(true);
    expect(review.threads).toHaveLength(1);
  });

  it("리뷰어가 코치나 운영자인 대화는 후보에서 뺀다", () => {
    const review = aggregateReviews({
      ...base,
      prs: [pr(1, "alice"), pr(2, "carol")],
      comments: [...thread(1, ["coach1", "alice", "coach1"]), ...thread(2, ["DaleSeo", "carol"])],
      isCoach: (login) => login === "coach1",
    });

    expect(review.threads).toEqual([]);
  });

  it("작성자가 답하지 않은 대화는 후보가 아니다", () => {
    const review = aggregateReviews({
      ...base,
      prs: [pr(1, "alice")],
      comments: thread(1, ["bob", "carol", "bob"]),
    });

    expect(review.threads).toEqual([]);
  });
});

describe("buildMentions", () => {
  it("Discord 멤버와 매칭되는 GitHub 아이디만 멘션 표에 넣는다", () => {
    const mentions = buildMentions(["alice", "bob"], [member("1", ["Alice"])]);
    expect([...mentions]).toEqual([["alice", "1"]]);
  });
});

describe("buildPraiseContext", () => {
  it("커버리지, 멘션, 코치 구분, 인용 후보를 모두 담는다", () => {
    const prs = [pr(1, "alice"), pr(2, "bob")];
    const comments = [
      comment(1, "bob", { body: "여기서 Set을 쓰면 어떨까요?" }),
      comment(2, "coach1"),
    ];
    const review = aggregateReviews({
      week: 1,
      prs,
      comments,
      assignments: new Map(),
      isCoach: (login) => login === "coach1",
    });

    const context = buildPraiseContext(review, comments, new Map([["bob", "42"]]));

    expect(context).toContain("# WEEK 1 코드 리뷰");
    expect(context).toContain("동료 리뷰를 받은 PR: 2개 (100%)");
    expect(context).toContain("멤버끼리 리뷰한 PR: 1개 (50%)");
    expect(context).toContain("- bob (<@42>): 코멘트 1건, 리뷰한 PR 1개");
    expect(context).toContain("- coach1 (코치): 코멘트 1건");
    expect(context).toContain("[PR #1] bob: 여기서 Set을 쓰면 어떨까요?");
  });

  it("멘션 표에 없는 사람은 멘션 불가로 표시한다", () => {
    const comments = [comment(1, "bob")];
    const review = aggregateReviews({
      week: 1,
      prs: [pr(1, "alice")],
      comments,
      assignments: new Map(),
      isCoach: noCoach,
    });

    expect(buildPraiseContext(review, comments, new Map())).toContain("- bob (멘션 불가)");
  });
});

describe("buildPraiseStarter / buildPraiseThreadName", () => {
  it("시작 메시지에만 기수 역할을 멘션한다", () => {
    expect(buildPraiseStarter(3, "999")).toContain("<@&999>");
    expect(buildPraiseThreadName(3)).not.toContain("<@&");
  });

  it("스레드 이름에 주차를 넣는다", () => {
    expect(buildPraiseThreadName(3)).toBe("🧵 WEEK 3 코드 리뷰 돌아보기");
  });
});
