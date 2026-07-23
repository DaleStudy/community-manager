import type { Env, RoleTeamConfig } from "./types.js";
import { getInstallationToken, checkSponsorship, getTeamCreatedAt, inviteToTeam, getTeamMembership } from "./github.js";
import { verifySignature, assignRole, getForumPosts, replyToMessage, addReaction } from "./discord.js";
import { buildWeekLabel, classify, computeWeekWindow } from "./blog.js";
import { collectFirstPostTimes, listRoleMembers, postMessage } from "./discord.js";

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
    // cron 패턴으로 분기: 블로그 발행 체크(월 09:00 KST = 월 00:00 UTC) vs 20분 주기 가입 처리
    if (event.cron === "0 0 * * MON") {
      ctx.waitUntil(handleBlogPublishCheck(env, event.scheduledTime));
    } else {
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

/** blog-study 원본 check_inactive_users 의 안내 문구를 포럼 게시 기준으로 다듬은 것. */
function buildReport(forumChannelId: string, warn: string[], late: string[]): string {
  if (warn.length === 0 && late.length === 0) {
    return `지난주 월요일 09:00부터 이번주 월요일 09:00까지 **${ROLE_LABEL}** 역할 대상자 모두 참여해서, 경고나 지각 대상자가 없습니다!`;
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
  return parts.join("\n\n");
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

  const firstTimes = await collectFirstPostTimes(guildId, forumChannelId, token, w.lastMonday9Utc, w.thisMonday9Utc);
  const memberIds = await listRoleMembers(guildId, roleId, token);

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

  await postMessage(channelId, buildReport(forumChannelId, warn, late), token);
  console.log(`[blog] report 게시 완료 warn=${warn.length} late=${late.length}`);

  // 새 주 시작 안내
  const label = buildWeekLabel(referenceMs);
  await postMessage(channelId, `${label}\n이번 주 블로그 글은 <#${forumChannelId}> 포럼에 새 게시글로 올려주세요!`, token);
  console.log(`[blog] 주간 안내 게시 완료 "${label}"`);
}
