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
  /** 블로그 발행 체크: 리포트/주간 안내를 올릴 텍스트 채널 ID */
  BLOG_STUDY_CHANNEL_ID: string;
  /** 블로그 발행 체크: 블로그 글을 게시하는 포럼 채널 ID */
  BLOG_STUDY_FORUM_ID: string;
  /** 블로그 발행 체크: 대상 'blog' 역할 ID */
  BLOG_STUDY_ROLE_ID: string;
  /** 베스트 글 순위표를 올릴 운영진 채널 ID */
  ADMIN_CHANNEL_ID: string;
  /** 달레UI 주간 업데이트: 스레드를 만들 디자인시스템 채널 ID */
  DALEUI_CHANNEL_ID: string;
  /** 달레UI 주간 업데이트: 대상 designsystem 역할 ID */
  DALEUI_ROLE_ID: string;
  /** 달레UI 주간 업데이트: 프로젝트 보드(projectV2) 번호 */
  DALEUI_PROJECT_NUMBER: string;
  /** 달레UI 주간 업데이트: `[{"discordId":"...","github":"..."}]` 형태의 멤버 매핑 */
  DALEUI_MEMBER_MAP: string;
  /** 모범 리뷰 칭찬: 스레드를 만들 리트코드 스터디 채널 ID */
  LEETCODE_CHANNEL_ID: string;
  /** 모범 리뷰 칭찬: 순위에서 제외할 coach 역할 ID */
  COACH_ROLE_ID: string;
  /** 같은 계정의 AI Gateway(dalestudy)를 토큰 없이 부르는 AI 바인딩 */
  AI: Ai;
}
