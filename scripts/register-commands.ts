import { readFileSync } from "fs";

try {
  const lines = readFileSync(".dev.vars", "utf-8").split("\n");
  for (const line of lines) {
    const match = line.match(/^([^=]+)=(.+)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^"|"$/g, "");
    }
  }
} catch {}

const APPLICATION_ID = process.env.DISCORD_APPLICATION_ID!;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN!;
const GUILD_ID = process.env.DISCORD_GUILD_ID!;
const ROLE_TEAM_CONFIG = JSON.parse(process.env.ROLE_TEAM_CONFIG!);

const choices = ROLE_TEAM_CONFIG.map((c: { value: string; label: string }) => ({
  name: c.label,
  value: c.value,
}));

const command = {
  name: "verify",
  description: "후원 여부를 확인하고 팀에 초대합니다.",
  options: [
    {
      name: "github_username",
      description: "GitHub 사용자 이름",
      type: 3, // STRING
      required: true,
    },
    {
      name: "discord_user_id",
      description: "Discord 사용자",
      type: 6, // USER
      required: true,
    },
    {
      name: "team",
      description: "참여할 팀",
      type: 3, // STRING
      required: true,
      choices,
    },
    {
      name: "role",
      description: "부여할 역할",
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

const result = await response.json();
console.log(JSON.stringify(result, null, 2));
