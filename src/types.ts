export interface RoleTeamConfig {
  value: string;
  label: string;
  discordRoleId: string;
  teamSlug: string;
}

export interface Env {
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_GUILD_ID: string;
  GITHUB_ORG: string;
  APP_ID: string;
  APP_INSTALLATION_ID: string;
  APP_PRIVATE_KEY: string;
  ROLE_TEAM_CONFIG: string;
  GH_PAT: string;
  DISCORD_APPLICATION_ID: string;
  STUDY_JOIN_CHANNEL_ID: string;
}
