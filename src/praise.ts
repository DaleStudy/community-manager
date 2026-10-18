import type { ActivityItem, CommentItem, ReviewAssignment } from "./github.js";
import type { GuildMember } from "./discord.js";
import { THREAD_NAME_PREFIX } from "./daleui.js";

/** 리트코드 스터디 답안 저장소 */
export const LEETCODE_REPO = "leetcode-study";

/** 운영자. 모든 PR을 멘토로서 리뷰하므로 멤버 순위와 분리한다. */
const OPERATOR = "DaleSeo";

const DAY_MS = 24 * 60 * 60 * 1000;

/** PR 목록 조회 범위. 주차 중간에 병합되고 그 뒤로 갱신이 없는 PR도 들어오도록 하루 더 본다. */
export const LOOKBACK_MS = 8 * DAY_MS;

/** 모범 리뷰 후보로 모델에 넘길 최대 대화 수 */
const MAX_THREADS = 5;

/** 인용 후보를 넘길 상위 멤버 수와 멤버당 코멘트 수 */
const QUOTE_MEMBERS = 5;
const QUOTES_PER_MEMBER = 4;

/** 코멘트 본문은 인용과 맥락 파악에 필요한 앞부분만 남긴다. */
const COMMENT_BODY_LIMIT = 300;

/** AI 코치 봇. 이슈 코멘트에서는 `[bot]` 접미사 없이 보인다. */
export function isBot(login: string): boolean {
  return login.endsWith("[bot]") || login === "dalestudy";
}

/** `[name] WEEK 03 Solutions` 형식의 풀이 PR 제목에서 주차를 읽는다. */
export function parseWeek(title: string): number | null {
  const match = title.match(/^\[[^\]]+\]\s*WEEK\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

/**
 * 방금 끝난 주차를 고른다. [nowMs - 7일, nowMs] 안에 병합된 풀이 PR에서 가장 많이 등장한 주차다.
 * 주차 마무리 때 그 주차 PR이 일괄 병합되므로, 생성 시각보다 병합 시각이 끝난 주차를 확실히 가리킨다.
 * 상한(nowMs)은 미리보기에서 과거 시점을 재생할 때 그 뒤 주차의 PR을 빼기 위해 필요하다.
 * 기수 사이처럼 병합된 풀이 PR이 없으면 null.
 */
export function pickTargetWeek(items: ActivityItem[], nowMs: number): number | null {
  const counts = new Map<number, number>();
  for (const it of items) {
    const mergedMs = it.mergedAt ? Date.parse(it.mergedAt) : NaN;
    if (!(mergedMs >= nowMs - 7 * DAY_MS && mergedMs <= nowMs)) continue;
    const week = parseWeek(it.title);
    if (week !== null) counts.set(week, (counts.get(week) ?? 0) + 1);
  }

  let best: number | null = null;
  for (const [week, count] of counts) {
    if (best === null || count > counts.get(best)!) best = week;
  }
  return best;
}

/** 대상 주차의 풀이 PR. 병합 없이 닫힌 PR은 중복 제출이라 뺀다. */
export function selectWeekPrs(items: ActivityItem[], week: number): ActivityItem[] {
  return items.filter(
    (it) =>
      it.isPullRequest &&
      parseWeek(it.title) === week &&
      !(it.state === "closed" && !it.mergedAt),
  );
}

/** Discord 이름(username, 닉네임, 표시 이름) 중 GitHub 아이디와 같은 멤버. 대소문자는 무시한다. */
export function matchMember(login: string, members: GuildMember[]): GuildMember | undefined {
  const needle = login.toLowerCase();
  return members.find((m) => m.names.some((n) => n.toLowerCase() === needle));
}

export type ReviewerGroup = "member" | "coach" | "operator";

export interface ReviewerStat {
  login: string;
  group: ReviewerGroup;
  /** 인라인 리뷰 코멘트와 PR 하단 코멘트를 합친 수 */
  comments: number;
  prs: number[];
  /** 리뷰 요청을 받지 않았는데 들어가 리뷰한 PR */
  voluntaryPrs: number[];
}

export interface ReviewThread {
  number: number;
  prAuthor: string;
  comments: CommentItem[];
}

export interface WeekReview {
  week: number;
  prCount: number;
  /** 작성자가 아닌 사람에게 리뷰를 받은 PR 수 */
  reviewedPrs: number;
  /** 코치와 운영자를 빼고 멤버에게 리뷰를 받은 PR 수 */
  memberReviewedPrs: number;
  botComments: number;
  /** 코멘트 수, 리뷰한 PR 수 순으로 내림차순 */
  reviewers: ReviewerStat[];
  threads: ReviewThread[];
  /** 왕복이 충분한 대화가 없어 2건짜리 대화까지 후보로 넓혔는지 */
  relaxedThreads: boolean;
}

/**
 * 한 주차의 리뷰 활동을 집계한다. 수치는 모두 여기서 계산하고,
 * 모델은 질적 판단(어떤 리뷰가 모범적인가)과 문장 작성만 맡는다.
 */
export function aggregateReviews(input: {
  week: number;
  prs: ActivityItem[];
  comments: CommentItem[];
  assignments: Map<number, ReviewAssignment>;
  isCoach: (login: string) => boolean;
}): WeekReview {
  const { week, prs, comments, assignments, isCoach } = input;
  const authorOf = new Map(prs.map((pr) => [pr.number, pr.author]));
  const groupOf = (login: string): ReviewerGroup =>
    login === OPERATOR ? "operator" : isCoach(login) ? "coach" : "member";

  const weekComments = comments.filter((c) => authorOf.has(c.number));
  const botComments = weekComments.filter((c) => isBot(c.author)).length;
  // 자기 PR에 단 답글은 리뷰가 아니라 응답이다.
  const reviewComments = weekComments.filter(
    (c) => !isBot(c.author) && c.author !== authorOf.get(c.number),
  );

  const commentCount = new Map<string, number>();
  const prsOf = new Map<string, Set<number>>();
  const addReview = (login: string, pr: number) => {
    if (!prsOf.has(login)) prsOf.set(login, new Set());
    prsOf.get(login)!.add(pr);
  };

  for (const c of reviewComments) {
    commentCount.set(c.author, (commentCount.get(c.author) ?? 0) + 1);
    addReview(c.author, c.number);
  }
  // 코멘트 없이 승인만 한 리뷰도 리뷰로 센다.
  for (const [pr, a] of assignments) {
    if (!authorOf.has(pr)) continue;
    for (const login of a.reviewers) {
      if (!isBot(login) && login !== authorOf.get(pr)) addReview(login, pr);
    }
  }

  const reviewers: ReviewerStat[] = [...prsOf].map(([login, set]) => {
    const prList = [...set].sort((a, b) => a - b);
    return {
      login,
      group: groupOf(login),
      comments: commentCount.get(login) ?? 0,
      prs: prList,
      voluntaryPrs: prList.filter((pr) => !assignments.get(pr)?.requested.includes(login)),
    };
  });
  reviewers.sort(
    (a, b) =>
      b.comments - a.comments || b.prs.length - a.prs.length || a.login.localeCompare(b.login),
  );

  const reviewedBy = (groups: ReviewerGroup[]) =>
    new Set(reviewers.filter((r) => groups.includes(r.group)).flatMap((r) => r.prs)).size;

  const { threads, relaxed } = findDialogueThreads(reviewComments, weekComments, authorOf, groupOf);

  return {
    week,
    prCount: prs.length,
    reviewedPrs: reviewedBy(["member", "coach", "operator"]),
    memberReviewedPrs: reviewedBy(["member"]),
    botComments,
    reviewers,
    threads,
    relaxedThreads: relaxed,
  };
}

/**
 * 리뷰어와 작성자가 실제로 의견을 주고받은 인라인 리뷰 대화를 찾는다.
 * 질문 → 답변 → 재응답으로 왕복한 대화를 우선하고, 그런 대화가 한 주에 하나도
 * 없으면 질문 → 답변 2건짜리까지 넓힌다. 리뷰어가 코치나 운영자인 대화는 뺀다 —
 * 그쪽 리뷰가 대개 가장 밀도가 높아 후보를 독차지하는데, 칭찬의 주인공은 멤버다.
 */
function findDialogueThreads(
  reviewComments: CommentItem[],
  weekComments: CommentItem[],
  authorOf: Map<number, string>,
  groupOf: (login: string) => ReviewerGroup,
): { threads: ReviewThread[]; relaxed: boolean } {
  // 리뷰 대화가 하나라도 있는 루트만 본다. 작성자 답글은 weekComments 에서 함께 모은다.
  const roots = new Set(
    reviewComments.filter((c) => c.isReviewComment).map((c) => c.inReplyTo ?? c.id),
  );
  const byRoot = new Map<number, CommentItem[]>();
  for (const c of weekComments) {
    if (!c.isReviewComment || isBot(c.author)) continue;
    const root = c.inReplyTo ?? c.id;
    if (!roots.has(root)) continue;
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root)!.push(c);
  }

  const dialogues: { thread: ReviewThread; switches: number }[] = [];
  for (const list of byRoot.values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const prAuthor = authorOf.get(list[0].number)!;
    const others = list.filter((c) => c.author !== prAuthor);
    if (others.length === list.length) continue; // 작성자가 답하지 않았다
    if (others.some((c) => groupOf(c.author) !== "member")) continue;

    let switches = 0;
    for (let i = 1; i < list.length; i++) {
      if ((list[i].author === prAuthor) !== (list[i - 1].author === prAuthor)) switches++;
    }
    dialogues.push({ thread: { number: list[0].number, prAuthor, comments: list }, switches });
  }

  const pick = (minComments: number, minSwitches: number) =>
    dialogues
      .filter((d) => d.thread.comments.length >= minComments && d.switches >= minSwitches)
      .sort((a, b) => b.thread.comments.length - a.thread.comments.length)
      .slice(0, MAX_THREADS)
      .map((d) => d.thread);

  const strict = pick(3, 2);
  return strict.length > 0 ? { threads: strict, relaxed: false } : { threads: pick(2, 1), relaxed: true };
}

const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

const clip = (body: string) => body.slice(0, COMMENT_BODY_LIMIT).replace(/\n+/g, " ");

/**
 * 집계 결과를 모델이 읽을 하나의 텍스트로 정리한다.
 * 멘션 표에 없는 사람은 모델이 이름 텍스트로만 쓴다.
 */
export function buildPraiseContext(
  review: WeekReview,
  comments: CommentItem[],
  mentions: Map<string, string>,
): string {
  const lines: string[] = [];
  const who = (login: string) => {
    const id = mentions.get(login);
    return id ? `${login} (<@${id}>)` : `${login} (멘션 불가)`;
  };

  lines.push(`# WEEK ${review.week} 코드 리뷰`);

  lines.push("\n## 리뷰 커버리지");
  lines.push(`- 풀이 PR: ${review.prCount}개`);
  lines.push(
    `- 동료 리뷰를 받은 PR: ${review.reviewedPrs}개 (${percent(review.reviewedPrs, review.prCount)}%)`,
  );
  lines.push(
    `- 코치와 운영자를 빼고 멤버끼리 리뷰한 PR: ${review.memberReviewedPrs}개 ` +
      `(${percent(review.memberReviewedPrs, review.prCount)}%)`,
  );
  lines.push(`- AI 코치 봇 코멘트: ${review.botComments}건 (참고용, 칭찬 대상 아님)`);

  const members = review.reviewers.filter((r) => r.group === "member");
  lines.push("\n## 멤버 리뷰어 순위 (칭찬 대상)");
  if (members.length === 0) lines.push("(없음)");
  for (const r of members) {
    const voluntary = r.voluntaryPrs.length
      ? ` 담당 외 자발적 리뷰: ${r.voluntaryPrs.map((n) => `#${n}`).join(", ")}`
      : "";
    lines.push(`- ${who(r.login)}: 코멘트 ${r.comments}건, 리뷰한 PR ${r.prs.length}개${voluntary}`);
  }

  const staff = review.reviewers.filter((r) => r.group !== "member");
  if (staff.length > 0) {
    lines.push("\n## 코치와 운영자 (칭찬 대상 아님, 참고용)");
    for (const r of staff) {
      const role = r.group === "coach" ? "코치" : "운영자";
      lines.push(`- ${r.login} (${role}): 코멘트 ${r.comments}건, 리뷰한 PR ${r.prs.length}개`);
    }
  }

  lines.push("\n## 멤버 리뷰 코멘트 원문 (인용 후보)");
  const quoted = new Set(members.slice(0, QUOTE_MEMBERS).map((r) => r.login));
  const quotes = comments.filter(
    (c) =>
      quoted.has(c.author) &&
      review.reviewers.some((r) => r.login === c.author && r.prs.includes(c.number)),
  );
  if (quotes.length === 0) lines.push("(없음)");
  for (const login of quoted) {
    for (const c of quotes.filter((q) => q.author === login).slice(0, QUOTES_PER_MEMBER)) {
      lines.push(`- [PR #${c.number}] ${login}: ${clip(c.body)} (${c.url})`);
    }
  }

  lines.push(
    `\n## 모범 리뷰 후보${review.relaxedThreads ? " (왕복 3건 이상인 대화가 없어 2건짜리까지 포함)" : ""}`,
  );
  if (review.threads.length === 0) lines.push("(없음)");
  review.threads.forEach((t, i) => {
    lines.push(`\n### 후보 ${i + 1}: PR #${t.number} (작성자 ${t.prAuthor})`);
    for (const c of t.comments) {
      const role = c.author === t.prAuthor ? "작성자" : "리뷰어";
      lines.push(`- ${c.author} (${role}): ${clip(c.body)} (${c.url})`);
    }
  });

  return lines.join("\n");
}

/** 메시지에 등장할 수 있는 GitHub 아이디 → Discord ID */
export function buildMentions(logins: string[], members: GuildMember[]): Map<string, string> {
  const mentions = new Map<string, string>();
  for (const login of logins) {
    const member = matchMember(login, members);
    if (member) mentions.set(login, member.id);
  }
  return mentions;
}

export const PRAISE_SYSTEM_PROMPT = `너는 달레 스터디 리트코드 스터디 운영진을 도와, 한 주차 동안 오간 코드 리뷰를 돌아보는 칭찬 메시지를 쓴다.
목적은 리뷰를 잘한 멤버를 칭찬해 코드 리뷰 문화를 북돋는 것이다.

## 좋은 리뷰의 기준 (스터디 코드 리뷰 가이드)

- 질문 중심: 더 나은 답을 강요하지 않고, 이해를 돕는 질문을 던진다.
- 상호 배려: 어조가 따뜻하고 존중한다.
- 언어 무관: 다른 언어로 쓴 풀이도 논리 흐름을 읽고 리뷰한다.
- 담당이 아닌데 자발적으로 들어가 남긴 리뷰는 특히 높게 본다.
코멘트 수만이 아니라 이 기준에 맞는 리뷰를 높게 친다.

## 작성 규칙

- 수치는 주어진 값만 쓴다. 직접 세거나 추정하지 않는다.
- 맨 앞에 한 줄 요약으로 리뷰 커버리지를 적는다. 코치와 운영자 리뷰를 뺀 멤버끼리의 수치가
  전체와 크게 다르면 두 수치를 함께 적어 멤버 참여도가 부풀려 보이지 않게 한다.
- 멤버 리뷰어 중 1~3명을 골라 수치와 실제 인용구를 따옴표로 함께 소개한다. 인용구는 원문을
  그대로 옮긴다. 상위권은 동점이 흔하니 억지로 순위를 가르지 말고 나란히 소개한다.
- 그 밖의 멤버 리뷰어는 한 줄에 묶어 고마움을 전한다.
- 담당 외 자발적 리뷰를 한 멤버가 있으면 한 줄로 따로 강조한다.
- 모범 리뷰 후보 중 1~2건을 골라 소개한다. 리뷰어와 작성자가 실제로 의견을 주고받은 대화를
  우선한다. 링크는 대화의 핵심이 담긴 댓글(핵심 질문, 작성자의 깨달음, 결정적인 제안)의
  URL을 주어진 그대로 쓴다. 'thread', '스레드' 같은 단어 없이 자연스럽게 소개한다.
  ("리뷰어와 작성자가 주고받은 이런 리뷰가 특히 좋았어요" 식)
- 코치, 운영자, AI 코치 봇은 칭찬 대상이 아니다. 단, 코치에게 리뷰를 받고 다시 풀어 온
  멤버를 소개하는 것은 좋다.
- 마지막에 이번 주에도 담당 PR 리뷰를 챙겨 달라는 독려를 가볍게 한 문장으로 넣는다.
  지난 주차에 리뷰를 안 한 사람을 호명하지 않는다.
- 리뷰가 거의 없는 주차라면 억지로 칭찬을 늘리지 말고 짧게 쓴다.

## 멘션

- 사람을 처음 언급할 때만 \`<@디스코드ID>\` 형태로 멘션하고 뒤에 이름을 다시 붙이지 않는다.
  ("<@123> 님" 처럼 쓴다. "<@123> alice 님"은 이름이 두 번 보인다.)
- 이미 멘션한 사람을 다시 가리킬 때는 멘션 없이 이름만 쓴다.
- "멘션 불가"로 표시된 사람은 GitHub 아이디를 텍스트로만 쓴다.
- 역할 멘션은 쓰지 않는다. 시작 메시지에 이미 있다.

## 문체

- 가볍고 대화체로 쓴다. "~는 모두의 몫이니" 같은 설교조나 딱딱한 표현은 피한다.
- 외래어보다 한국어를 쓴다. (suggestion → 제안, 머지 → 병합) PR, 리뷰, 코멘트는 그대로 둔다.
- 이모지는 절제한다. 순위에 🥇🥈🥉 정도만 쓰고, 인용구 속 이모지는 원문대로 둔다.
- em dash(—), 나열용 가운뎃점(·), 나열용 \`+\` 는 쓰지 않는다. 쉼표, 콜론, 괄호, 줄바꿈으로 푼다.
- 섹션을 나눌 때는 \`### \` 헤더를 쓴다.

설명이나 머리말 없이 게시할 본문만 출력한다.`;

/** 모델에게 넘길 사용자 메시지 */
export function buildPraisePrompt(context: string): string {
  return `아래는 지난 주차 코드 리뷰를 집계한 결과다. 이걸로 칭찬 메시지를 작성해줘.\n\n${context}`;
}

/** 채널에 올릴 스레드 시작 메시지 — 역할 멘션은 여기 한 번만 등장한다. */
export function buildPraiseStarter(week: number, roleId: string): string {
  return (
    `WEEK ${week} 코드 리뷰 돌아보기 ${THREAD_NAME_PREFIX}\n` +
    `<@&${roleId}> 지난주에 서로 주고받은 코드 리뷰 중 특히 좋았던 순간들을 모아봤어요!`
  );
}

/** 스레드 이름 (100자 제한) */
export function buildPraiseThreadName(week: number): string {
  return `${THREAD_NAME_PREFIX} WEEK ${week} 코드 리뷰 돌아보기`.slice(0, 100);
}
