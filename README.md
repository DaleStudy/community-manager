# Community Manager Bot

Discord slash command `/verify <github_username>` → GitHub 후원 확인 → GitHub 팀 초대 + Discord 역할 부여

리트코드 스터디 운영 자동화 프로세스를 위한 Discord 봇입니다.

## 개요

DaleStudy 커뮤니티 운영을 자동화하는 Cloudflare Worker 기반 Discord 봇입니다. 하나의 Worker가 세 가지 작업을 처리합니다.

1. **`/verify` 슬래시 명령**: 사용자의 GitHub 후원 여부를 확인해, 후원자인 경우 GitHub 조직 팀에 초대하고 Discord 역할(Role)을 부여합니다.
2. **리트코드 스터디 가입 처리** (cron, 20분 주기): 스터디 신청 포럼에 올라온 글을 폴링해 위 검증 로직을 자동 적용합니다.
3. **블로그 발행 체크** (cron, 매주 월요일 09:00 KST): `blog` 역할 대상자가 이번 주 블로그를 발행(블로그글-공유 포럼에 게시글 작성)했는지 확인해 리포트를 올리고 새 주 시작 안내를 게시합니다.

## 아키텍처

```
Discord User
    │
    │  /verify <github_username>
    ▼
Discord API
    │
    │  POST (Interaction Webhook)
    ▼
Cloudflare Worker  ──────────────────────────────┐
    │                                             │
    │  GraphQL: sponsorshipsAsMaintainer(org)     │
    ▼                                             │
GitHub API (Sponsors)                             │
    │                                             │
    ├─ 후원 O ──► GitHub REST API (팀 초대)        │
    │                                             │
    └─ 후원 O ──► Discord REST API (역할 부여) ───┘
```

위 그림은 `/verify` 인터랙션(`fetch` 핸들러) 흐름입니다. 이와 별개로, 봇은 **Cron Trigger로 두 가지 작업**을 `scheduled` 핸들러에서 주기적으로 실행하며 `event.cron` 값으로 분기합니다.

```
Cloudflare Cron ──► Worker.scheduled(event.cron)
   */20 * * * *  ──► handleLeetCodeSignUp      (신청 포럼 폴링 → 후원 검증 재사용)
   0 0 * * MON   ──► handleBlogPublishCheck     (blog 역할 발행 체크 → 리포트 + 새 스레드)
```

## 기술 스택

| Layer         | Technology                                                              |
| ------------- | ----------------------------------------------------------------------- |
| Runtime       | Cloudflare Workers (TypeScript)                                         |
| Slash Command | Discord Interactions API                                                |
| 후원 확인     | GitHub GraphQL API (`sponsorshipsAsMaintainer`)                         |
| 팀 초대       | GitHub REST API (`PUT /orgs/{org}/teams/{team}/memberships/{username}`) |
| 역할 부여     | Discord REST API (`PUT /guilds/{guild}/members/{user}/roles/{role}`)    |
| 배포          | Wrangler CLI                                                            |

## 프로젝트 구조

```
community-manager/
├── src/
│   ├── index.ts          # Cloudflare Worker entry point
│   ├── discord.ts        # Discord 서명 검증, API 호출
│   ├── github.ts         # GitHub GraphQL/REST API 호출
│   ├── blog.ts           # 블로그 발행 체크 로직 (KST 주간 경계·발행 상태 분류)
│   └── types.ts          # 공통 타입 정의
├── scripts/
│   └── register.ts       # Discord slash command 등록 스크립트
├── wrangler.jsonc        # Cloudflare Worker 설정
├── tsconfig.json         # TypeScript 설정
├── package.json          # Node.js 패키지 설정
└── README.md             # 프로젝트 설명
```

## 환경 변수

### Cloudflare Secrets (운영진만 접근)

| Key                          | 설명                                       |
| ---------------------------- | ------------------------------------------ |
| `DISCORD_PUBLIC_KEY`         | Discord App의 Ed25519 공개키, 서명 검증용 (조직 공용 봇) |
| `DISCORD_TOKEN`              | Discord Bot Token (조직 공용 봇)           |
| `DISCORD_APPLICATION_ID`     | Discord Application ID (조직 공용 봇)       |
| `DISCORD_GUILD_ID`           | 대상 Discord 서버 ID                       |
| `GITHUB_APP_ID`              | GitHub App ID                              |
| `GITHUB_APP_INSTALLATION_ID` | GitHub App의 조직 Installation ID          |
| `GITHUB_APP_PRIVATE_KEY`     | GitHub App Private Key (PEM 형식)          |
| `GH_PAT`                     | GitHub PAT (후원 조회 GraphQL용)           |

> **봇 자격증명 일원화**: `DISCORD_TOKEN`·`DISCORD_PUBLIC_KEY`·`DISCORD_APPLICATION_ID`는 커뮤니티 공용 봇(`DaleStudy`)의 **조직 레벨** 시크릿이며, CI(GitHub Actions) 배포 시 자동으로 주입됩니다. 저장소별로 개인 봇 자격증명을 따로 관리하지 않습니다.

### wrangler.jsonc vars (공개값, 커밋됨)

| Key                | 설명              |
| ------------------ | ----------------- |
| `GITHUB_ORG`       | GitHub 조직 이름                   |
| `ROLE_TEAM_CONFIG` | 역할-팀 매핑 (JSON, 슬래시 선택지) |
| `STUDY_JOIN_CHANNEL_ID` | 리트코드 스터디 신청 포럼 채널 ID (cron 자동 처리) |
| `BLOG_STUDY_CHANNEL_ID` | 블로그 발행 체크: 리포트/주간 안내를 올릴 채널 ID |
| `BLOG_STUDY_FORUM_ID`   | 블로그 발행 체크: 블로그 글을 게시하는 포럼 채널 ID |
| `BLOG_STUDY_ROLE_ID`    | 블로그 발행 체크: 대상 `blog` 역할 ID       |

### 로컬 개발 (.dev.vars)

`.dev.vars.example`을 복사해 `.dev.vars`를 만들고 운영진에게 값을 전달받아 채워넣으세요.

파일 아래쪽의 주석 처리된 항목은 **로컬 테스트용 오버라이드**입니다. 채우면 `wrangler.jsonc`의 `vars`보다 우선하므로, 채널·역할 ID를 테스트 서버 값으로 바꿔두면 cron을 직접 트리거해도 운영 채널에 게시되지 않습니다. `DISCORD_GUILD_ID`도 함께 테스트 서버로 바꿔야 역할 조회가 맞물립니다.

```bash
cp .dev.vars.example .dev.vars
```

## 배포 및 개발

### 사전 준비

1. Cloudflare 계정 및 Wrangler CLI 설치
2. Discord 애플리케이션 생성 및 Bot 설정
3. GitHub 조직 및 팀 설정
4. 환경 변수 준비

### 로컬 개발

```bash
# 의존성 설치 (필요시)
npm install

# 로컬 테스트
wrangler dev

# 배포 전 검증
wrangler deploy --dry-run

# 배포
wrangler deploy
```

### 현재 배포 상태

- **Worker URL**: https://community-manager.dalestudy.workers.dev
- **버전 ID**: 10b174de-123a-4a25-896c-efb8550830c1
- **마지막 배포**: 2026-04-07

## 구현 태스크

- [ ] 1. 프로젝트 초기 세팅 (Wrangler, TypeScript)
- [ ] 2. Discord slash command 등록 스크립트 작성
- [ ] 3. Cloudflare Worker 진입점 및 라우팅 구현
- [ ] 4. Discord Ed25519 서명 검증 구현
- [ ] 5. GitHub GraphQL 후원 확인 구현
- [ ] 6. GitHub REST API 팀 초대 구현
- [ ] 7. Discord REST API 역할 부여 구현
- [ ] 8. Deferred response + followup 메시지 흐름 구현
- [ ] 9. 환경변수 설정 및 Cloudflare 배포
- [ ] 10. Discord Bot 권한 설정 및 end-to-end 테스트

## 주요 고려사항

- **서명 검증**: Discord는 응답 속도와 무관하게 서명 검증 실패 시 webhook endpoint를 차단함. Web Crypto API 사용 필수
- **응답 시간**: Discord Interaction은 3초 내 응답 필요 → Deferred Response 패턴 필수
- **GitHub App 권한**: 후원 확인(GraphQL)과 팀 초대(REST) 모두 처리. Organization Members: Read & Write 권한 필요
- **Bot 역할 위치**: Discord에서 Bot이 부여할 역할보다 높은 위치에 있어야 함
- **중복 실행 방지**: PUT 방식으로 멱등성 보장
- **블로그 발행 체크**: 역할 보유자 열거(`GET /guilds/{id}/members`)에 GUILD_MEMBERS(privileged) 인텐트 필요. 주간 cron은 매주 1회 단일 실행이라 동시성 경합 없음

## 주요 동작 상세

### 후원 검증 로직

`/verify` 실행 시 후원 조건을 아래 방식으로 검증합니다.

- GitHub GraphQL API로 해당 유저의 **전체 후원 기록**을 조회합니다. (비공개 후원도 포함 — `sponsorshipsAsMaintainer(includePrivate: true)`)
- 조회한 기록 중 **팀 생성일 이후**의 기록만 필터링합니다.
- one-time 후원과 정기 후원을 구분하지 않고 **금액을 모두 합산**합니다.
- 합산 금액이 **$5 이상**이면 검증 통과입니다.

예시:

| 후원 기록 | 팀 생성일 기준 | 합산 금액 | 결과 |
|---|---|---|---|
| $4 one-time + $1 one-time (팀 생성 이후) | 모두 포함 | $5 | 통과 |
| $3/month 정기 (팀 생성 이후 시작) | 포함 | $3 | 실패 |
| $3 one-time (팀 생성 이전) + $3 one-time (팀 생성 이후) | 이후 것만 포함 | $3 | 실패 |

### 중복 가입 처리

`/verify` 실행 시 대상 유저가 이미 GitHub 팀의 활성 멤버인 경우, 팀 초대를 다시 진행하되 Discord 역할만 재부여하고 별도 안내 메시지를 응답합니다.

| 상태 | 응답 메시지 |
|---|---|
| 이미 활성 멤버 | `ℹ️ 이미 팀의 멤버입니다. Discord 역할이 재부여되었습니다.` |
| 신규 초대 (org 멤버) | `✅ GitHub 팀 초대가 완료되었습니다.` |
| 신규 초대 (외부 유저) | `✅ 팀 초대 메일이 발송되었습니다.` |

### 리트코드 스터디 가입 자동 처리 (cron)

20분 주기(`*/20 * * * *`)로 스터디 신청 포럼(`STUDY_JOIN_CHANNEL_ID`)을 폴링합니다. 아직 처리되지 않은(리액션 없는) 신청 글의 제목/본문에서 `(github_username, team)`을 파싱해 위 후원 검증 로직을 적용하고, 결과를 답글 + ✅/❌ 리액션으로 남깁니다.

### 블로그 발행 체크 (주간 cron)

매주 월요일 09:00 KST(`0 0 * * MON`)에 실행되어, `blog` 역할 대상자가 이번 주 블로그를 발행(블로그글-공유 포럼에 게시글 작성)했는지 확인합니다.

- 포럼 채널(`BLOG_STUDY_FORUM_ID`)의 게시글(스레드)을 훑어, 각자의 **첫 게시글 생성 시각**으로 분류합니다.
  생성 시각은 게시글 ID(snowflake)에서 얻으므로 메시지 내용은 읽지 않고, `blog` 역할이 없는
  사람의 게시글은 판정에 영향을 주지 않습니다.

| 상태 | 기준 (KST) | 처리 |
|---|---|---|
| 정상 발행 | 이번 주 월 00:00 이전 게시 | (조용히 통과) |
| 지각 | 이번 주 월 00:00 ~ 09:00 첫 게시 | 리포트에 지각 표기 |
| 경고 | 미게시 | 리포트에 경고 표기 |

- 판정 결과를 리포트 채널(`BLOG_STUDY_CHANNEL_ID`)에 게시하고, 새 주 시작 안내 메시지를 올립니다.

> 주간 판정 창(지난 월 09:00 ~ 이번 월 09:00)과 분류 로직은 [`src/blog.ts`](src/blog.ts)에 있고, 경계는 단위 테스트([`src/blog.test.ts`](src/blog.test.ts))로 검증합니다.

## 라이선스

이 프로젝트는 MIT 라이선스를 따릅니다.
