# Community Manager Bot

Discord slash command `/verify <github_username>` → GitHub 후원 확인 → GitHub 팀 초대 + Discord 역할 부여

리트코드 스터디 운영 자동화 프로세스를 위한 Discord 봇입니다.

## 개요

이 프로젝트는 Discord 서버에서 `/verify <github_username>` 명령을 통해 사용자의 GitHub 후원 여부를 확인하고, 후원자인 경우 자동으로 GitHub 조직 팀에 초대하고 Discord 역할(Role)을 부여하는 Cloudflare Worker 기반 봇입니다.

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
    │  GraphQL: isSponsoredBy(org)                │
    ▼                                             │
GitHub API (Sponsors)                             │
    │                                             │
    ├─ 후원 O ──► GitHub REST API (팀 초대)        │
    │                                             │
    └─ 후원 O ──► Discord REST API (역할 부여) ───┘
```

## 기술 스택

| Layer         | Technology                                                              |
| ------------- | ----------------------------------------------------------------------- |
| Runtime       | Cloudflare Workers (TypeScript)                                         |
| Slash Command | Discord Interactions API                                                |
| 후원 확인     | GitHub GraphQL API (`isOrganizationSponsoredBy`)                        |
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
| `DISCORD_PUBLIC_KEY`         | Discord App의 Ed25519 공개키 (서명 검증용) |
| `DISCORD_BOT_TOKEN`          | Discord Bot Token                          |
| `DISCORD_GUILD_ID`           | 대상 Discord 서버 ID                       |
| `DISCORD_ROLE_ID`            | 부여할 역할 ID                             |
| `GITHUB_APP_ID`              | GitHub App ID                              |
| `GITHUB_APP_INSTALLATION_ID` | GitHub App의 조직 Installation ID          |
| `GITHUB_APP_PRIVATE_KEY`     | GitHub App Private Key (PEM 형식)          |

### wrangler.jsonc vars (공개값, 커밋됨)

| Key                | 설명              |
| ------------------ | ----------------- |
| `GITHUB_ORG`       | GitHub 조직 이름  |
| `GITHUB_TEAM_SLUG` | 초대할 팀 slug    |

### 로컬 개발 (.dev.vars)

`.dev.vars.example`을 복사해 `.dev.vars`를 만들고 운영진에게 값을 전달받아 채워넣으세요.

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

## 라이선스

이 프로젝트는 MIT 라이선스를 따릅니다.
