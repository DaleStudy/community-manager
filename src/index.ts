import type { Env, RoleTeamConfig } from "./types.js";
import { getInstallationToken, checkSponsorship, getTeamCreatedAt, inviteToTeam, getTeamMembership } from "./github.js";
import { getLatestMeetingIssue, getProjectItems, listRecentComments, listRecentIssuesAndPulls } from "./github.js";
import { verifySignature, assignRole, getForumPosts, replyToMessage, addReaction } from "./discord.js";
import type { Engagement } from "./blog.js";
import { buildRankingReport, buildWeekRange, classify, computeWeekWindow, firstPostTimes, rankPosts } from "./blog.js";
import type { WeeklyThread } from "./discord.js";
import { collectWeeklyThreads, getEngagement, listRoleMembers, postMessage } from "./discord.js";
import { createThread, listMessages, postMessageWithRoleMention } from "./discord.js";
import {
  SUMMARY_SYSTEM_PROMPT,
  THREAD_NAME_PREFIX,
  buildContext,
  buildThreadName,
  buildThreadStarter,
  buildUserPrompt,
  computeWindow,
  formatPeriod,
  parseMembers,
  reconcileMembers,
  splitForDiscord,
} from "./daleui.js";
import { generateSummary } from "./claude.js";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const signature = request.headers.get("X-Signature-Ed25519") ?? "";
    const timestamp = request.headers.get("X-Signature-Timestamp") ?? "";
    const body = await request.text();

    const isValid = await verifySignature(env.DISCORD_PUBLIC_KEY, signature, timestamp, body);
    if (!isValid) {
      return new Response("Unauthorized", { status: 401 });
    }

    const interaction = JSON.parse(body);

    // PING
    if (interaction.type === 1) {
      return Response.json({ type: 1, message: "PONG - Worker is alive" });
    }

    // APPLICATION_COMMAND
    if (interaction.type === 2) {
      ctx.waitUntil(
        handleVerify(interaction, env)
          .then((message) => editFollowup(env.DISCORD_APPLICATION_ID, interaction.token, message))
          .catch((err) => editFollowup(env.DISCORD_APPLICATION_ID, interaction.token, `⚠️ 오류가 발생했습니다: ${err?.message ?? "알 수 없는 오류"}`)),
      );
      return Response.json({ type: 5 });
    }

    return new Response("Unknown interaction type", { status: 400 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // cron 패턴으로 분기
    if (event.cron === "0 0 * * MON") {
      // 블로그 발행 체크 (월 09:00 KST)
      ctx.waitUntil(handleBlogPublishCheck(env, event.scheduledTime));
    } else if (event.cron === "0 23 * * FRI") {
      // 달레UI 주간 업데이트 (토 08:00 KST — 09:30 회의 1시간 30분 전)
      ctx.waitUntil(handleDaleuiWeeklyUpdate(env, event.scheduledTime));
    } else {
      // 20분 주기 가입 처리
      ctx.waitUntil(handleLeetCodeSignUp(env));
    }
  },
};

async function editFollowup(applicationId: string, token: string, content: string): Promise<void> {
  await fetch(
    `https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
}

async function handleVerify(interaction: any, env: Env): Promise<string> {
  const options = interaction.data?.options ?? [];
  const githubUsername = options.find((o: any) => o.name === "github_username")
    ?.value as string;
  const roleValue = options.find((o: any) => o.name === "role")
    ?.value as string;
  const teamValue = options.find((o: any) => o.name === "team")
    ?.value as string;
  const discordUserId = options.find((o: any) => o.name === "discord_user_id")?.value as string;

  console.log(`[verify] github=${githubUsername} team=${teamValue} role=${roleValue} discordUserId=${discordUserId}`);

  return processVerify(githubUsername, teamValue, roleValue, discordUserId, env);
}

async function processVerify(
  githubUsername: string,
  teamValue: string,
  roleValue: string,
  discordUserId: string,
  env: Env,
): Promise<string> {
  const config: RoleTeamConfig[] = JSON.parse(env.ROLE_TEAM_CONFIG);
  const roleConfig = config.find((c) => c.value === roleValue);
  const teamConfig = config.find((c) => c.value === teamValue);

  if (!roleConfig || !teamConfig) {
    console.log(`[verify] invalid role=${roleValue} or team=${teamValue}`);
    const validTeams = config.map((c) => c.value).join(", ");
    return `⚠️ 잘못된 team 값입니다: \`${teamValue}\`\n유효한 team: ${validTeams}\n포스트 **제목(title)** 을 아래 형식으로 작성해주세요. (두 번째 값은 닉네임이 아니라 팀 식별자입니다)\n\`\`\`\n리트코드 스터디 8기 신청 (github_username, team)\n\`\`\``;
  }

  const token = await getInstallationToken(env);
  const sponsorship = await checkSponsorship(githubUsername, env.GITHUB_ORG, env.GH_PAT);

  console.log(`[verify] sponsorship=${JSON.stringify(sponsorship)}`);

  if (!sponsorship.sponsored) {
    return "❌ 해당 GitHub 계정의 후원 내역을 찾을 수 없습니다.";
  }

  const teamCreatedAt = await getTeamCreatedAt(env.GITHUB_ORG, teamConfig.teamSlug, token);

  const eligibleRecords = sponsorship.records.filter((r) => r.createdAt >= teamCreatedAt);
  const totalAmount = eligibleRecords.reduce((sum, r) => sum + r.amount, 0);

  console.log(`[verify] teamCreatedAt=${teamCreatedAt} eligibleRecords=${eligibleRecords.length} totalAmount=${totalAmount}`);

  if (totalAmount < 5) {
    return `❌ 팀 생성일 이후 후원 금액($${totalAmount})이 $5 미만입니다. 후원 내역이 맞다면 운영자에게 문의해주세요.`;
  }

  const existingMembership = await getTeamMembership(env.GITHUB_ORG, teamConfig.teamSlug, githubUsername, token);

  const [state] = await Promise.all([
    inviteToTeam(env.GITHUB_ORG, teamConfig.teamSlug, githubUsername, token),
    assignRole(env.DISCORD_GUILD_ID, discordUserId, roleConfig.discordRoleId, env.DISCORD_TOKEN),
  ]);

  console.log(`[verify] existingMembership=${existingMembership}, invited to team state=${state}, assigned Discord role=${roleConfig.discordRoleId}`);

  const amountLabel = `$${totalAmount}`;

  if (existingMembership === "active") {
    return `ℹ️ **${githubUsername}**님은 이미 **${teamConfig.teamSlug}** 팀의 멤버입니다. Discord 역할이 재부여되었습니다.`;
  }

  if (state === "active") {
    return `✅ GitHub 팀 **${teamConfig.teamSlug}** 초대가 완료되었습니다. (후원 금액: ${amountLabel})`;
  }

  return `✅ GitHub 연동 이메일로 팀 초대 메일이 발송되었습니다. 메일함을 확인하고 초대를 수락해주세요. (후원 금액: ${amountLabel})`;
}

interface ParsedJoinMessage {
  githubUsername: string;
  team: string;
}

function parseJoinMessage(content: string): ParsedJoinMessage | null {
  const normalized = content.replace(/：/g, ":");

  const match = normalized.match(/\(\s*([^,)]+?)\s*,\s*([^)]+?)\s*\)/);

  if (!match) return null;

  return {
    githubUsername: match[1],
    team: match[2],
  };
}

async function handleLeetCodeSignUp(env: Env): Promise<void> {
  const posts = await getForumPosts(env.DISCORD_GUILD_ID, env.STUDY_JOIN_CHANNEL_ID, env.DISCORD_TOKEN);

  const unprocessed = posts.filter((msg) => {
    if (msg.author?.bot) return false;
    return !msg.reactions?.length;
  });

  console.log(`[cron] total=${posts.length} unprocessed=${unprocessed.length}`);

  for (const msg of unprocessed) {
    const threadId = msg.threadId as string;
    const content = msg.content ?? "";
    const threadName = msg.threadName ?? "";
    console.log(`[cron] threadId=${threadId} content=${JSON.stringify(content)} threadName=${JSON.stringify(threadName)}`);
    const parsed = parseJoinMessage(content) ?? parseJoinMessage(threadName);

    if (!parsed) {
      console.log(`[cron] parse failed threadId=${threadId}`);
      await replyToMessage(
        threadId,
        msg.id,
        "⚠️ 메시지 형식이 올바르지 않습니다. 포스트 **제목(title)** 에 아래 형식으로 작성해주세요.\n```\n리트코드 스터디 8기 신청 (github_username, team)\n```",
        env.DISCORD_TOKEN,
      );
      await addReaction(threadId, msg.id, "❌", env.DISCORD_TOKEN);
      continue;
    }

    console.log(`[cron] processing threadId=${threadId} github=${parsed.githubUsername} team=${parsed.team}`);

    try {
      const result = await processVerify(
        parsed.githubUsername,
        parsed.team,
        parsed.team,
        msg.author.id,
        env,
      );
      await replyToMessage(threadId, msg.id, result, env.DISCORD_TOKEN);
      const reaction = result.startsWith("❌") || result.startsWith("⚠️") ? "❌" : "✅";
      await addReaction(threadId, msg.id, reaction, env.DISCORD_TOKEN);
    } catch (err: any) {
      console.error(`[cron] error threadId=${threadId}`, err);
      await replyToMessage(
        threadId,
        msg.id,
        `⚠️ 오류가 발생했습니다: ${err?.message ?? "알 수 없는 오류"}`,
        env.DISCORD_TOKEN,
      );
      await addReaction(threadId, msg.id, "❌", env.DISCORD_TOKEN);
    }
  }
}

// ── 블로그 발행 체크(blog-study) 처리 ──────────────────────────────
const ROLE_LABEL = "blog"; // 리포트 표시용 역할명

function mentions(ids: string[]): string {
  return ids.map((id) => `<@${id}>`).join(" ");
}

/**
 * blog-study 원본 check_inactive_users 의 안내 문구를 포럼 게시 기준으로 다듬은 것.
 * 지난주 판정과 새 주 안내를 한 메시지에 담는다 — 매주 같은 자리에 두 개가 연달아
 * 올라오면 채널이 그만큼 길어지고, 둘은 어차피 같은 시점의 같은 이야기다.
 */
function buildReport(
  forumChannelId: string,
  warn: string[],
  late: string[],
  weekRange: string,
): string {
  const notice = `이번 주(${weekRange}) 블로그 글은 <#${forumChannelId}> 포럼에 새 게시글로 올려주세요!`;

  if (warn.length === 0 && late.length === 0) {
    return `지난주 월요일 09:00부터 이번주 월요일 09:00까지 **${ROLE_LABEL}** 역할 대상자 모두 참여해서, 경고나 지각 대상자가 없습니다!\n\n${notice}`;
  }

  const parts: string[] = [];
  if (warn.length > 0) {
    parts.push(
      `지난주 월요일 09:00부터 이번주 월요일 09:00까지, **${ROLE_LABEL}** 역할 대상자 중 <#${forumChannelId}> 포럼에 글을 게시하지 않아 **경고 1회**를 받은 사람들:\n${mentions(warn)}`,
    );
  }
  if (late.length > 0) {
    parts.push(
      `이번주 월요일 00:00~09:00 사이에, **${ROLE_LABEL}** 역할 대상자 중 <#${forumChannelId}> 포럼에 처음으로 글을 게시해 **지각 1회**를 받은 사람들:\n${mentions(late)}`,
    );
  }
  parts.push(notice);
  return parts.join("\n\n");
}

/** 순위표에 보여줄 글 수 — 상위 3개가 베스트, 나머지는 대체 후보다. */
const RANKING_SIZE = 5;

/**
 * 베스트 글 선정용 순위표를 운영진 채널에 게시한다. 최종 선정은 운영진이 보고 판단한다.
 * blog 역할 대상자의 글만 세므로 운영진이 올리는 안내 글은 자연히 빠진다.
 */
async function postRanking(
  threads: WeeklyThread[],
  memberIds: string[],
  channelId: string,
  token: string,
  referenceMs: number,
): Promise<void> {
  const members = new Set(memberIds);
  const candidates = threads.filter((t) => members.has(t.ownerId));

  // rate limit을 피해 순차 조회한다.
  const posts: (WeeklyThread & Engagement)[] = [];
  for (const thread of candidates) {
    posts.push({ ...thread, ...(await getEngagement(thread, token)) });
  }

  const ranked = rankPosts(posts);
  console.log(
    `[blog] 순위 집계 candidates=${candidates.length} ` +
      ranked.slice(0, RANKING_SIZE).map((p) => `${p.title}(${p.score})`).join(" / "),
  );

  // 아직 확정 전 초안이라 당사자에게 핑을 보내지 않는다.
  await postMessage(channelId, buildRankingReport(ranked, RANKING_SIZE, referenceMs), token, false);
}

/**
 * 매주 월요일 09:00(KST) 실행. 블로그글-공유 포럼에 지난 한 주 동안 올라온 게시글을
 * 기준으로 blog 역할 대상자의 블로그 발행/지각을 판정해 리포트를 올리고,
 * 새 주 시작 안내 메시지를 게시한다.
 */
async function handleBlogPublishCheck(env: Env, referenceMs: number): Promise<void> {
  const token = env.DISCORD_TOKEN;
  const guildId = env.DISCORD_GUILD_ID;
  const channelId = env.BLOG_STUDY_CHANNEL_ID;
  const forumChannelId = env.BLOG_STUDY_FORUM_ID;
  const roleId = env.BLOG_STUDY_ROLE_ID;

  const w = computeWeekWindow(referenceMs);
  console.log(
    `[blog] reference=${new Date(referenceMs).toISOString()} ` +
      `window=[${new Date(w.lastMonday9Utc).toISOString()} .. ${new Date(w.thisMonday9Utc).toISOString()}]`,
  );

  const threads = await collectWeeklyThreads(guildId, forumChannelId, token, w.lastMonday9Utc, w.thisMonday9Utc);
  const memberIds = await listRoleMembers(guildId, roleId, token);

  const firstTimes = firstPostTimes(threads);
  const warn: string[] = [];
  const late: string[] = [];
  for (const id of memberIds) {
    switch (classify(firstTimes.get(id), w)) {
      case "late":
        late.push(id);
        break;
      case "warn":
        warn.push(id);
        break;
      // "normal" → 정상 참여, 아무것도 하지 않음
    }
  }

  const weekRange = buildWeekRange(referenceMs);
  await postMessage(channelId, buildReport(forumChannelId, warn, late, weekRange), token);
  console.log(`[blog] report 게시 완료 warn=${warn.length} late=${late.length} week="${weekRange}"`);

  await postRanking(threads, memberIds, env.ADMIN_CHANNEL_ID, token, referenceMs);
}

// ── 달레UI 주간 업데이트 처리 ──────────────────────────────────────

/** 활동을 수집할 저장소 */
const DALEUI_REPOS = ["daleui", "daleui.com"];

/** 채널 대화에서 읽어올 최근 메시지 수 — 회의 시간 변경 같은 결정이 여기 남는다. */
const DALEUI_CHANNEL_MESSAGES = 30;

export interface DaleuiCollection {
  meetingTitle: string;
  period: string;
  memberCount: number;
  /** 모델에게 넘길 활동 흔적 원문 */
  context: string;
}

/**
 * 게시에 필요한 재료를 모은다. 부수효과가 없는 읽기 전용 단계라
 * 로컬 미리보기(`npm run preview:daleui`)에서도 그대로 재사용한다.
 */
export async function collectDaleuiUpdate(
  env: Env,
  referenceMs: number,
): Promise<DaleuiCollection> {
  const token = env.DISCORD_TOKEN;
  const org = env.GITHUB_ORG;
  const channelId = env.DALEUI_CHANNEL_ID;

  // 역할 멤버를 매번 다시 조회해 탈퇴·합류 변동을 반영한다.
  const roleMemberIds = await listRoleMembers(env.DISCORD_GUILD_ID, env.DALEUI_ROLE_ID, token);
  const members = reconcileMembers(roleMemberIds, parseMembers(env.DALEUI_MEMBER_MAP));

  const { startMs, endMs } = computeWindow(referenceMs);
  const sinceIso = new Date(startMs).toISOString();
  const period = formatPeriod(startMs, endMs);

  console.log(`[daleui] 멤버=${members.length} 기간=${period} since=${sinceIso}`);

  const ghToken = await getInstallationToken(env);

  const [activity, comments, board, meeting, channelMessages] = await Promise.all([
    Promise.all(
      DALEUI_REPOS.map((repo) => listRecentIssuesAndPulls(org, repo, sinceIso, ghToken)),
    ).then((r) => r.flat()),
    Promise.all(
      DALEUI_REPOS.map((repo) => listRecentComments(org, repo, sinceIso, ghToken)),
    ).then((r) => r.flat()),
    getProjectItems(org, Number(env.DALEUI_PROJECT_NUMBER), ghToken),
    getLatestMeetingIssue(org, DALEUI_REPOS[0], ghToken),
    listMessages(channelId, token, DALEUI_CHANNEL_MESSAGES),
  ]);

  const meetingTitle = meeting?.title ?? "주간 회의";

  console.log(
    `[daleui] 수집 완료 활동=${activity.length} 코멘트=${comments.length} ` +
      `보드=${board.length} 대화=${channelMessages.length} 회의="${meetingTitle}"`,
  );

  return {
    meetingTitle,
    period,
    memberCount: members.length,
    context: buildContext({
      members,
      meetingTitle,
      period,
      activity,
      comments,
      board,
      discordMessages: channelMessages,
    }),
  };
}

/**
 * 매주 토요일 08:00(KST) 실행. 회의(09:30) 전에 GitHub·Discord 활동을 취합해
 * 디자인시스템 채널에 개인 업데이트 스레드를 만들고 멤버별 요약을 게시한다.
 *
 * 수집은 이 함수가, 무엇이 완료·리스크인지에 대한 판단은 모델이 맡는다.
 */
async function handleDaleuiWeeklyUpdate(env: Env, referenceMs: number): Promise<void> {
  const token = env.DISCORD_TOKEN;
  const channelId = env.DALEUI_CHANNEL_ID;

  const { meetingTitle, context } = await collectDaleuiUpdate(env, referenceMs);

  const summary = await generateSummary(
    SUMMARY_SYSTEM_PROMPT,
    buildUserPrompt(context),
    env.AI_GATEWAY_TOKEN,
  );

  // 역할 멘션은 채널의 시작 메시지에 한 번만. 스레드 안에서는 개인 멘션만 쓴다.
  const starterId = await postMessageWithRoleMention(
    channelId,
    buildThreadStarter(meetingTitle, env.DALEUI_ROLE_ID),
    token,
  );
  const threadId = await createThread(
    channelId,
    starterId,
    buildThreadName(meetingTitle),
    token,
  );

  const chunks = splitForDiscord(summary);
  for (const chunk of chunks) {
    await postMessage(threadId, chunk, token);
  }

  console.log(`[daleui] 게시 완료 threadId=${threadId} 메시지=${chunks.length}개`);
}
