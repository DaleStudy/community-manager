import type { RoleTeamConfig } from "../src/types.js";

const BOT_TOKEN = process.env.DISCORD_TOKEN;
const APPLICATION_ID = process.env.DISCORD_APPLICATION_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const ROLE_TEAM_CONFIG = process.env.ROLE_TEAM_CONFIG;

if (!BOT_TOKEN || !APPLICATION_ID || !GUILD_ID || !ROLE_TEAM_CONFIG) {
  console.error("필요한 환경 변수가 설정되지 않았습니다.");
  console.error(
    "필요: DISCORD_TOKEN, DISCORD_APPLICATION_ID, DISCORD_GUILD_ID, ROLE_TEAM_CONFIG",
  );
  process.exit(1);
}

const config: RoleTeamConfig[] = JSON.parse(ROLE_TEAM_CONFIG);
const choices = config.map((c) => ({ name: c.label, value: c.value }));

const command = {
  name: "verify",
  description: "GitHub 후원을 확인하고 팀에 초대합니다",
  options: [
    {
      name: "github_username",
      description: "GitHub 유저명",
      type: 3, // STRING
      required: true,
    },
    {
      name: "role",
      description: "부여받을 역할",
      type: 3, // STRING
      required: true,
      choices,
    },
    {
      name: "team",
      description: "초대될 GitHub 팀",
      type: 3, // STRING
      required: true,
      choices,
    },
  ],
};

const response = await fetch(
  `https://discord.com/api/v10/applications/${APPLICATION_ID}/guilds/${GUILD_ID}/commands`,
  {
    method: "PUT",
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([command]),
  },
);

if (!response.ok) {
  const error = await response.json();
  console.error("커맨드 등록 실패:", JSON.stringify(error, null, 2));
  process.exit(1);
}

const result = await response.json();
console.log("커맨드 등록 성공:", JSON.stringify(result, null, 2));
