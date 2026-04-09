import type { Env, RoleTeamConfig } from "./types.js";
import { getInstallationToken, checkSponsorship } from "./github.js";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const body = await request.text();
    const interaction = JSON.parse(body);

    // PING
    if (interaction.type === 1) {
      return Response.json({ type: 1 });
    }

    // APPLICATION_COMMAND
    if (interaction.type === 2) {
      ctx.waitUntil(handleVerify(interaction, env));
      return Response.json({ type: 5 }); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    }

    return new Response("Unknown interaction type", { status: 400 });
  },
};

async function handleVerify(interaction: any, env: Env): Promise<void> {
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
    await sendFollowup(interaction, "⚠️ 잘못된 role 또는 team 값입니다.");
    return;
  }

  const token = await getInstallationToken(env);
  const isSponsored = await checkSponsorship(githubUsername, env.GITHUB_ORG, token);

  if (!isSponsored) {
    await sendFollowup(
      interaction,
      "❌ 해당 GitHub 계정의 후원 내역을 찾을 수 없습니다.",
    );
    return;
  }

  // TODO: 팀 초대 → 역할 부여
  await sendFollowup(
    interaction,
    "🔧 후원 확인됨. 팀 초대/역할 부여 구현 예정입니다.",
  );
}

async function sendFollowup(interaction: any, content: string): Promise<void> {
  const appId = interaction.application_id;
  const token = interaction.token;

  await fetch(
    `https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
}
