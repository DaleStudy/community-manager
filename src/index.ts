import type { Env, RoleTeamConfig } from "./types.js";
import { getInstallationToken, checkSponsorship, getTeamCreatedAt, inviteToTeam } from "./github.js";
import { verifySignature, assignRole } from "./discord.js";

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

  const config: RoleTeamConfig[] = JSON.parse(env.ROLE_TEAM_CONFIG);
  const roleConfig = config.find((c) => c.value === roleValue);
  const teamConfig = config.find((c) => c.value === teamValue);

  if (!roleConfig || !teamConfig) {
    return "⚠️ 잘못된 role 또는 team 값입니다.";
  }

  const token = await getInstallationToken(env);
  const sponsorship = await checkSponsorship(githubUsername, env.GITHUB_ORG, env.GH_PAT);

  if (!sponsorship.sponsored) {
    return "❌ 해당 GitHub 계정의 후원 내역을 찾을 수 없습니다.";
  }

  if (!sponsorship.isOneTimePayment || (sponsorship.amount ?? 0) < 5) {
    return `❌ one-time $5 이상 후원자만 가입 가능합니다. (현재: ${sponsorship.isOneTimePayment ? `$${sponsorship.amount ?? 0} one-time` : "정기 후원"})`;
  }

  const teamCreatedAt = await getTeamCreatedAt(env.GITHUB_ORG, teamConfig.teamSlug, token);

  if (sponsorship.lastSponsoredAt! < teamCreatedAt) {
    return `❌ 가장 최근 후원일(${sponsorship.lastSponsoredAt!.slice(0, 10)})이 팀 생성일(${teamCreatedAt.slice(0, 10)}) 이전입니다.`;
  }

  const discordUserId = options.find((o: any) => o.name === "discord_user_id")?.value as string;
  const [state] = await Promise.all([
    inviteToTeam(env.GITHUB_ORG, teamConfig.teamSlug, githubUsername, token),
    assignRole(env.DISCORD_GUILD_ID, discordUserId, roleConfig.discordRoleId, env.DISCORD_BOT_TOKEN),
  ]);

  const amountLabel = `$${sponsorship.amount} one-time`;

  if (state === "active") {
    return `✅ 팀에 바로 추가되었습니다. (후원 금액: ${amountLabel})`;
  }

  return `✅ 초대 메일을 발송했습니다. 수락 후 팀에 합류됩니다. (후원 금액: ${amountLabel})`;
}
