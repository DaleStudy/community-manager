import type { Env, RoleTeamConfig } from "./types.js";
import { getInstallationToken, checkSponsorship, getTeamCreatedAt, inviteToTeam, getTeamMembership } from "./github.js";
import { verifySignature, assignRole, getForumPosts, replyToMessage, addReaction } from "./discord.js";

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

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleChannelJoin(env));
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
    return `❌ 가장 최근 후원 금액($${totalAmount})이 $5 미만입니다. 여러 번 후원하셨다면 API 한계로 최근 1건만 확인됩니다. 운영자에게 문의해주세요.`;
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

async function handleChannelJoin(env: Env): Promise<void> {
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
