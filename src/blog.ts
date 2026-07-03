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
 * 한 대상자의 "첫 메시지 시각"(없으면 undefined)으로 블로그 발행 상태를 판정한다.
 * - normal: 이번주 월 00:00(KST) 이전에 작성 (정상 발행)
 * - late:   이번주 월 00:00~09:00(KST) 사이 첫 작성 (지각)
 * - warn:   미작성 또는 그 외 (경고)
 */
export function classify(firstMessageMs: number | undefined, w: WeekWindow): BlogStatus {
  if (firstMessageMs === undefined) return "warn";
  if (firstMessageMs < w.thisMondayMidnightUtc) return "normal";
  if (firstMessageMs >= w.thisMondayMidnightUtc && firstMessageMs <= w.thisMonday9Utc) return "late";
  return "warn";
}

/** 스레드 제목용 "블로그 MM/DD - MM/DD" (KST 기준, 기준 주 월~일) */
export function buildThreadName(referenceMs: number): string {
  const start = new Date(referenceMs + KST_OFFSET_MS);
  const end = new Date(start.getTime() + 6 * DAY_MS);
  return `블로그 ${fmtMonthDay(start)} - ${fmtMonthDay(end)}`;
}

function fmtMonthDay(d: Date): string {
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${mm}/${dd}`;
}
