/** 한국 시간대(KST, UTC+9) 오프셋 (ms) */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface WeekWindow {
  /** 지난주 월요일 09:00(KST) — UTC ms */
  lastMonday9Utc: number;
  /** 이번주 월요일 00:00(KST) — UTC ms */
  thisMondayMidnightUtc: number;
  /** 이번주 월요일 09:00(KST) — UTC ms */
  thisMonday9Utc: number;
}

/**
 * 기준 시각(보통 cron이 발화한 "월요일 09:00 KST")을 바탕으로
 * 블로그 발행 판정에 쓰는 KST 주간 경계를 계산한다.
 *
 * blog-study Rust 원본의 this_week_monday_midnight_kst + 관련 계산을 옮긴 것.
 */
export function computeWeekWindow(referenceMs: number): WeekWindow {
  // +9h 이동 후 getUTC* 를 쓰면 KST 벽시계 값을 얻는다.
  const kst = new Date(referenceMs + KST_OFFSET_MS);
  const dow = kst.getUTCDay(); // 0=일 .. 6=토 (KST 기준)
  const daysFromMonday = (dow + 6) % 7; // 월=0 .. 일=6

  // 이번 주 월요일 00:00 (shifted 공간의 자정)
  const mondayMidnightShifted =
    Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) -
    daysFromMonday * DAY_MS;

  const thisMondayMidnightUtc = mondayMidnightShifted - KST_OFFSET_MS;
  const thisMonday9Utc = thisMondayMidnightUtc + KST_OFFSET_MS; // 월 09:00 KST
  const lastMonday9Utc = thisMonday9Utc - 7 * DAY_MS;

  return { lastMonday9Utc, thisMondayMidnightUtc, thisMonday9Utc };
}

export type BlogStatus = "normal" | "late" | "warn";

/**
 * 한 대상자의 "첫 게시글 시각"(없으면 undefined)으로 블로그 발행 상태를 판정한다.
 * - normal: 이번주 월 00:00(KST) 이전에 게시 (정상 발행)
 * - late:   이번주 월 00:00~09:00(KST) 사이 첫 게시 (지각)
 * - warn:   미게시 또는 그 외 (경고)
 */
export function classify(firstPostMs: number | undefined, w: WeekWindow): BlogStatus {
  if (firstPostMs === undefined) return "warn";
  if (firstPostMs < w.thisMondayMidnightUtc) return "normal";
  if (firstPostMs >= w.thisMondayMidnightUtc && firstPostMs <= w.thisMonday9Utc) return "late";
  return "warn";
}

/** 사람별 "첫 게시글 시각"을 뽑는다. */
export function firstPostTimes(posts: { ownerId: string; createdMs: number }[]): Map<string, number> {
  const first = new Map<string, number>();
  for (const p of posts) {
    const prev = first.get(p.ownerId);
    if (prev === undefined || p.createdMs < prev) first.set(p.ownerId, p.createdMs);
  }
  return first;
}

/** 댓글 1개에 매기는 점수. 댓글은 반응보다 희소해서 더 무겁게 친다. */
const COMMENT_WEIGHT = 3;

/** 게시글 작성자 본인과 봇을 제외한 참여 지표 */
export interface Engagement {
  /** 고유 반응자 수 (한 사람이 이모지를 여러 개 눌러도 1) */
  reactors: number;
  /** 댓글 수 */
  comments: number;
}

export interface Post extends Engagement {
  threadId: string;
  ownerId: string;
  createdMs: number;
}

export type RankedPost = Post & { score: number };

/**
 * 참여 지표로 점수를 매겨 내림차순 정렬한다.
 * 동점이면 반응자가 많은 글이, 그래도 같으면 먼저 올라온 글이 앞선다.
 */
export function rankPosts<T extends Post>(posts: T[]): (T & { score: number })[] {
  return posts
    .map((p) => ({ ...p, score: p.reactors + COMMENT_WEIGHT * p.comments }))
    .sort((a, b) => b.score - a.score || b.reactors - a.reactors || a.createdMs - b.createdMs);
}

const MEDALS = ["🥇", "🥈", "🥉"];

/**
 * 운영진 채널에 올릴 순위표. 상위 3개에 메달을 달고, 그 아래는 대체 후보로 함께 보여준다.
 * 최종 선정은 운영진이 이 순위표를 보고 판단한다.
 */
export function buildRankingReport(ranked: RankedPost[], topN: number, referenceMs: number): string {
  const week = buildWeekRange(referenceMs - 7 * DAY_MS);
  const shown = ranked.filter((p) => p.score > 0).slice(0, topN);

  if (shown.length === 0) {
    return `📊 **블로그 ${week} 순위**\n추천이나 댓글을 받은 글이 없어 순위를 매기지 못했습니다.`;
  }

  const lines = shown.map((p, i) => {
    const rank = MEDALS[i] ?? `\`${i + 1}위\``;
    return `${rank} <#${p.threadId}> — <@${p.ownerId}>\n> 추천 ${p.reactors} · 댓글 ${p.comments} → **${p.score}점**`;
  });

  return [
    `📊 **블로그 ${week} 순위** — 이 중에서 베스트 글을 골라주세요`,
    `-# 추천 1점 · 댓글 ${COMMENT_WEIGHT}점 (작성자 본인의 반응·댓글은 제외)`,
    ...lines,
  ].join("\n");
}

/** 주간 범위 "MM/DD - MM/DD" (KST 기준, 기준 주 월~일) */
export function buildWeekRange(referenceMs: number): string {
  const start = new Date(referenceMs + KST_OFFSET_MS);
  const end = new Date(start.getTime() + 6 * DAY_MS);
  return `${fmtMonthDay(start)} - ${fmtMonthDay(end)}`;
}

function fmtMonthDay(d: Date): string {
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${mm}/${dd}`;
}
