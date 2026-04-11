import type { Env, RoleTeamConfig } from "./types.js";
import { getInstallationToken, checkSponsorship, getTeamCreatedAt, inviteToTeam } from "./github.js";
import { verifySignature } from "./discord.js";

export default {
  async fetch(
    request: Request,
    env: Env,
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
      const message = await handleVerify(interaction, env);
      return Response.json({ type: 4, data: { content: message } });
    }

    return new Response("Unknown interaction type", { status: 400 });
  },
};

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
  const sponsorship = await checkSponsorship(githubUsername, env.GITHUB_ORG, token);

  if (!sponsorship.sponsored) {
    return "❌ 해당 GitHub 계정의 후원 내역을 찾을 수 없습니다.";
  }

  if ((sponsorship.amountInDollars ?? 0) < 5) {
    return `❌ 후원 금액이 $5 미만입니다. (현재: $${sponsorship.amountInDollars})`;
  }

  const teamCreatedAt = await getTeamCreatedAt(env.GITHUB_ORG, teamConfig.teamSlug, token);

  if (sponsorship.lastSponsoredAt! < teamCreatedAt) {
    return `❌ 가장 최근 후원일(${sponsorship.lastSponsoredAt!.slice(0, 10)})이 팀 생성일(${teamCreatedAt.slice(0, 10)}) 이전입니다.`;
  }

  const state = await inviteToTeam(env.GITHUB_ORG, teamConfig.teamSlug, githubUsername, token);

  if (state === "active") {
    return "✅ 팀에 바로 추가되었습니다.";
  }

  return "✅ 초대 메일을 발송했습니다. 수락 후 팀에 합류됩니다.";
}
