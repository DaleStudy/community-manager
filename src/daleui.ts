import type { ActivityItem, BoardItem, CommentItem } from "./github.js";
import type { ChannelMessage } from "./discord.js";

/** 한국 시간대(KST, UTC+9) 오프셋 (ms) */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Discord 메시지 하나에 들어갈 수 있는 최대 글자 수 */
export const DISCORD_MESSAGE_LIMIT = 2000;

/** 봇이 만드는 업데이트 스레드 이름의 접두사 — 직전 스레드를 되찾을 때 쓴다. */
export const THREAD_NAME_PREFIX = "🧵";

export interface Member {
  discordId: string;
  github: string;
}

/** `DALEUI_MEMBER_MAP` 환경 변수(JSON 배열)를 파싱한다. */
export function parseMembers(json: string): Member[] {
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error("DALEUI_MEMBER_MAP 은 배열이어야 합니다");
  }
  return parsed.map((m) => ({ discordId: String(m.discordId), github: String(m.github) }));
}

/**
 * 취합 기간을 정한다. 직전 업데이트 스레드가 있으면 그 시점부터, 없으면 최근 7일.
 * 스레드가 생긴 뒤의 활동만 봐야 같은 내용을 두 번 올리지 않는다.
 */
export function computeWindow(
  nowMs: number,
  previousThreadMs: number | undefined,
): { startMs: number; endMs: number } {
  const startMs =
    previousThreadMs !== undefined && previousThreadMs < nowMs
      ? previousThreadMs
      : nowMs - 7 * DAY_MS;
  return { startMs, endMs: nowMs };
}

/** "M/D~M/D" (KST 기준) */
export function formatPeriod(startMs: number, endMs: number): string {
  const fmt = (ms: number) => {
    const d = new Date(ms + KST_OFFSET_MS);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  };
  return `${fmt(startMs)}~${fmt(endMs)}`;
}

/**
 * 역할 멤버 목록과 매핑 표를 대조한다. 매핑에 없는 멤버도 빠뜨리지 않고 포함하되
 * GitHub 핸들은 비워 둔다 — 새로 합류한 사람이 통째로 누락되는 것을 막는다.
 */
export function reconcileMembers(roleMemberIds: string[], mapped: Member[]): Member[] {
  const byId = new Map(mapped.map((m) => [m.discordId, m]));
  return roleMemberIds.map((id) => byId.get(id) ?? { discordId: id, github: "" });
}

/** 코멘트 본문은 맥락 파악에 필요한 앞부분만 남긴다. */
const COMMENT_BODY_LIMIT = 500;

export interface CollectedData {
  members: Member[];
  meetingTitle: string;
  period: string;
  activity: ActivityItem[];
  comments: CommentItem[];
  board: BoardItem[];
  discordMessages: ChannelMessage[];
}

/**
 * 수집한 원자료를 모델이 읽을 하나의 텍스트로 정리한다.
 * 판단은 전혀 하지 않는다 — 무엇이 중요한지는 모델이 정한다.
 */
export function buildContext(data: CollectedData): string {
  const lines: string[] = [];

  lines.push(`# 회의: ${data.meetingTitle}`);
  lines.push(`# 취합 기간: ${data.period}`);

  lines.push("\n## 팀 멤버 (Discord ID ↔ GitHub 핸들)");
  for (const m of data.members) {
    lines.push(`- ${m.discordId} ↔ ${m.github || "(GitHub 핸들 미확인)"}`);
  }

  lines.push("\n## GitHub 이슈·PR 활동");
  if (data.activity.length === 0) {
    lines.push("(없음)");
  }
  for (const a of data.activity) {
    const kind = a.isPullRequest ? "PR" : "이슈";
    const merged = a.mergedAt ? " 병합됨" : "";
    const assignees = a.assignees.length ? ` 담당:${a.assignees.join(",")}` : "";
    const labels = a.labels.length ? ` 라벨:${a.labels.join(",")}` : "";
    lines.push(
      `- [${a.repo}] ${kind} #${a.number} "${a.title}" ` +
        `작성:${a.author} 상태:${a.state}${merged}${assignees}${labels} ` +
        `생성:${a.createdAt} 갱신:${a.updatedAt}`,
    );
  }

  lines.push("\n## GitHub 코멘트·리뷰");
  if (data.comments.length === 0) {
    lines.push("(없음)");
  }
  for (const c of data.comments) {
    const kind = c.isReviewComment ? "리뷰" : "코멘트";
    const body = c.body.slice(0, COMMENT_BODY_LIMIT).replace(/\n+/g, " ");
    lines.push(`- [${c.repo}] #${c.number} ${kind} ${c.author}: ${body}`);
  }

  lines.push("\n## 프로젝트 보드");
  if (data.board.length === 0) {
    lines.push("(없음)");
  }
  for (const b of data.board) {
    const where = b.repo && b.number ? `[${b.repo}#${b.number}] ` : "";
    const assignees = b.assignees.length ? ` 담당:${b.assignees.join(",")}` : "";
    const estimate = b.estimate !== null ? ` 추정:${b.estimate}` : "";
    lines.push(
      `- ${where}"${b.title}" 상태:${b.status ?? "-"} ` +
        `스프린트:${b.sprint ?? "-"} 우선순위:${b.priority ?? "-"}${estimate}${assignees}`,
    );
  }

  lines.push("\n## Discord 채널 대화");
  if (data.discordMessages.length === 0) {
    lines.push("(없음)");
  }
  for (const m of data.discordMessages) {
    if (!m.content.trim()) continue;
    lines.push(`- ${m.authorName}: ${m.content.replace(/\n+/g, " ")}`);
  }

  return lines.join("\n");
}

export const SUMMARY_SYSTEM_PROMPT = `너는 달레UI 디자인시스템 팀의 주간 회의 준비를 돕는다.
GitHub과 Discord에서 모은 활동 흔적을 받아, 멤버별 업데이트 요약을 작성한다.
멤버들은 빈 칸을 채우는 대신 "누락되거나 틀린 부분만" 정정하면 되도록 하는 것이 목적이다.

## 작성 규칙

- 역할 멤버 전원을 빠짐없이 다룬다. 활동이 전혀 안 잡히는 멤버는 지어내지 말고
  "이번 주 확인된 기여 없음 — 진행 있으시면 보태주세요"라고 명시한다.
- 멤버 나열 순서는 이번 주 기여가 많은 사람부터 내림차순이다. 병합·생성된 PR,
  신규 등록 이슈, 리뷰·코멘트, 보드 진행 등 흔적의 양과 비중을 종합해 판단한다.
  기여가 없는 멤버는 맨 뒤로 보낸다. 멤버 목록의 순서는 매핑용일 뿐 게시 순서가 아니다.
- 한 불릿에는 한 항목만 담는다. 불릿 개수 상한은 없다 — 기여가 많으면 길어지는 게 맞다.
  단 같은 종류의 묶음(리뷰 여러 건, 연관 이슈 일괄 등록)은 한 불릿에 번호를 나열해도 된다.
- 이슈/PR 번호는 반드시 병기한다 (예: \`#982\`, \`PR #55\`).
- dependabot 등 봇의 PR은 멤버 활동이 아니므로 "기타"로 한 줄 처리한다.

## 상태 아이콘 (4종만 쓴다)

- ✅ 완료: PR 병합, 이슈 종료, 릴리즈
- ▶️ 진행: In Progress, 초안 PR, 활발한 논의
- ⚠️ 주의: 보드에 할당됐으나 미착수이거나, 착수 여부를 확인할 수 없음.
  단 보드가 In Progress인데 GitHub에 흔적이 없으면 Figma 등 외부 작업일 수 있으므로
  ▶️ 진행으로 두고 "확인 불가 — 진행분 보태주세요"라고 적어 정정을 유도한다.
  진행 중인 것을 정체로 오해시키지 않는다.
- 🚨 위험: 오랫동안 정체된 것(In Progress 장기 정체, 초안 PR 수 주째 방치),
  외부 검토 대기, 방향 미결 등 실제 일정·목표 리스크. 기준을 좁게 지켜 남발하지 않는다.
  새 이슈를 등록·제안한 것은 시작 안 한 게 아니라 그 자체가 기여이므로 ✅로 본다.

## 출력 형식

첫머리에 이렇게 적는다:
📋 회의 준비를 위해 지난주(<기간>) GitHub/Discord 활동을 미리 취합해봤어요. 각자 확인하시고 **누락되거나 틀린 부분, 여기 없는 진행 상황만 보태주시면** 됩니다!
-# ✅ 완료 · ▶️ 진행 · ⚠️ 주의 · 🚨 위험

그다음 멤버마다:
### <@디스코드ID>
- ✅ 불릿 내용

마지막에 (해당 항목이 있을 때만):
### 🚨 일정·목표 리스크
1. 스프린트 관점에서 본 리스크

### 📌 논의 후보
1. 리뷰어 없는 PR, 할당 후 무활동 이슈, 미결 논의

## 문체

- 헤더에 GitHub 핸들을 병기하지 않는다. 멘션이 이미 이름을 보여준다.
- 외래어 대신 자연스러운 한국어를 쓴다: 머지→병합, 오픈(PR을 열다)→생성/열기,
  클로즈→종료, 리네임→이름 변경, 핸드오프→인계, 드래프트→초안.
  단 정착된 기술 용어(PR, 이슈, 리뷰, 커밋, 스레드)는 그대로 둔다.
- 이미 확정된 사안은 논의 후보에 넣지 않는다. 채널 대화에서 확정 여부를 확인한다.

설명이나 머리말 없이 게시할 본문만 출력한다.`;

/** 모델에게 넘길 사용자 메시지 */
export function buildUserPrompt(context: string): string {
  return `아래는 이번 주 수집된 활동 흔적이다. 이걸로 멤버별 업데이트 요약을 작성해줘.\n\n${context}`;
}

/**
 * Discord 메시지 길이 제한에 맞춰 나눈다. 멤버 구분자인 H3 헤더(\`### \`) 경계에서만
 * 자르므로 한 사람의 요약이 두 메시지에 걸치지 않는다.
 * 한 블록이 그 자체로 제한을 넘으면 줄 단위로 마저 나눈다.
 */
export function splitForDiscord(text: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
  const blocks: string[] = [];
  let current: string[] = [];

  for (const line of text.split("\n")) {
    if (line.startsWith("### ") && current.length > 0) {
      blocks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current.join("\n"));

  const messages: string[] = [];
  let buffer = "";

  const flush = () => {
    if (buffer.trim()) messages.push(buffer.trim());
    buffer = "";
  };

  for (const block of blocks) {
    if (block.length > limit) {
      flush();
      messages.push(...splitByLine(block, limit));
      continue;
    }
    if (buffer.length + block.length + 1 > limit) flush();
    buffer = buffer ? `${buffer}\n${block}` : block;
  }
  flush();

  return messages;
}

/** 헤더 경계로도 안 되는 큰 덩어리를 줄 단위로 쪼갠다. */
function splitByLine(block: string, limit: number): string[] {
  const out: string[] = [];
  let buffer = "";

  for (const line of block.split("\n")) {
    const piece = line.length > limit ? line.slice(0, limit) : line;
    if (buffer.length + piece.length + 1 > limit) {
      if (buffer.trim()) out.push(buffer.trim());
      buffer = piece;
    } else {
      buffer = buffer ? `${buffer}\n${piece}` : piece;
    }
  }
  if (buffer.trim()) out.push(buffer.trim());

  return out;
}

/** 채널에 올릴 스레드 시작 메시지 — 역할 멘션은 여기 한 번만 등장한다. */
export function buildThreadStarter(meetingTitle: string, roleId: string): string {
  return `${meetingTitle} 전 개인 업데이트 ${THREAD_NAME_PREFIX}\n<@&${roleId}> 회의 전에 이 스레드에 각자 진행 상황을 남겨주세요!`;
}

/** 스레드 이름 (100자 제한) */
export function buildThreadName(meetingTitle: string): string {
  return `${THREAD_NAME_PREFIX} ${meetingTitle} 전 개인 업데이트`.slice(0, 100);
}
