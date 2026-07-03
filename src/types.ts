export interface RoleTeamConfig {
  value: string;
  label: string;
  discordRoleId: string;
  teamSlug: string;
}

export interface Env {
  DISCORD_PUBLIC_KEY: string;
  DISCORD_TOKEN: string;
  DISCORD_GUILD_ID: string;
  GITHUB_ORG: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  ROLE_TEAM_CONFIG: string;
  GH_PAT: string;
  DISCORD_APPLICATION_ID: string;
  STUDY_JOIN_CHANNEL_ID: string;
  /** 블로그 발행 체크: 스레드를 만들 부모 채널 ID */
  BLOG_STUDY_CHANNEL_ID: string;
  /** 블로그 발행 체크: 대상 'blog' 역할 ID */
  BLOG_STUDY_ROLE_ID: string;
}
