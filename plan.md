# Community Manager Bot — Implementation Plan

## Overview

Discord slash command `/verify <github_username>` → GitHub 후원 확인 → GitHub 팀 초대 + Discord 역할 부여

---

## Architecture

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

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers (TypeScript) |
| Slash Command | Discord Interactions API |
| 후원 확인 | GitHub GraphQL API (`isOrganizationSponsoredBy`) |
| 팀 초대 | GitHub REST API (`PUT /orgs/{org}/teams/{team}/memberships/{username}`) |
| 역할 부여 | Discord REST API (`PUT /guilds/{guild}/members/{user}/roles/{role}`) |
| 배포 | Wrangler CLI |

---

## Step-by-Step Flow

### 1. Discord Interaction 수신
- Cloudflare Worker가 Discord Interaction Webhook을 수신
- `Ed25519` 서명 검증 (필수 — 실패 시 Discord가 endpoint를 비활성화함)
- Interaction type `PING(1)` → 즉시 `PONG` 응답
- Interaction type `APPLICATION_COMMAND(2)` → 처리 시작

### 2. Deferred Response 반환
- GitHub API 호출이 3초를 초과할 수 있으므로, 즉시 `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE(5)` 반환
- 이후 처리 결과를 `followup` 메시지로 전송

### 3. GitHub 후원 확인
- GitHub GraphQL API로 `<github_username>`이 조직을 후원하는지 확인
```graphql
query {
  user(login: "<github_username>") {
    isSponsoredBy(accountLogin: "<org_name>")
  }
}
```
- 필요 token scope: `read:org`, `read:user`

### 4. GitHub 팀 초대
- 후원 확인 시 GitHub REST API로 팀 멤버십 추가
```
PUT /orgs/{org}/teams/{team_slug}/memberships/{username}
Body: { "role": "member" }
```
- 필요 token scope: `admin:org`

### 5. Discord 역할 부여
- Discord REST API로 명령어를 실행한 유저에게 역할 추가
```
PUT /guilds/{guild_id}/members/{user_id}/roles/{role_id}
```
- Bot이 해당 역할보다 높은 위치에 있어야 함

### 6. Followup 메시지 전송
- 성공: "✅ 후원이 확인되었습니다. GitHub 팀과 Discord 역할이 부여되었습니다."
- 후원 없음: "❌ 해당 GitHub 계정의 후원 내역을 찾을 수 없습니다."
- 오류: "⚠️ 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요."

---

## Project Structure

```
community-manager-test/
├── src/
│   ├── index.ts          # Cloudflare Worker entry point
│   ├── discord.ts        # Discord 서명 검증, API 호출
│   ├── github.ts         # GitHub GraphQL/REST API 호출
│   └── types.ts          # 공통 타입 정의
├── scripts/
│   └── register.ts       # Discord slash command 등록 스크립트
├── wrangler.toml         # Cloudflare Worker 설정
├── package.json
└── tsconfig.json
```

---

## Environment Variables (Cloudflare Secrets)

| Key | 설명 |
|-----|------|
| `DISCORD_PUBLIC_KEY` | Discord App의 Ed25519 공개키 (서명 검증용) |
| `DISCORD_BOT_TOKEN` | Discord Bot Token |
| `DISCORD_GUILD_ID` | 대상 Discord 서버 ID |
| `DISCORD_ROLE_ID` | 부여할 역할 ID |
| `GITHUB_TOKEN` | GitHub Personal Access Token (또는 GitHub App token) |
| `GITHUB_ORG` | GitHub 조직 이름 |
| `GITHUB_TEAM_SLUG` | 초대할 팀 slug |

---

## Implementation Tasks

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

---

## Key Considerations

- **서명 검증**: Discord는 응답 속도와 무관하게 서명 검증 실패 시 webhook endpoint를 차단함. Web Crypto API (`SubtleCrypto`) 사용 필수 (Node.js `crypto` 모듈은 Workers에서 사용 불가)
- **응답 시간**: Discord Interaction은 3초 내 응답 필요 → Deferred Response 패턴 필수
- **GitHub Token 권한**: 후원 확인은 GraphQL API, 팀 초대는 REST API — 두 권한을 모두 가진 단일 token 또는 GitHub App 사용 권장
- **Bot 역할 위치**: Discord에서 Bot이 부여할 역할보다 낮은 위치에 있으면 역할 부여 실패
- **중복 실행 방지**: 이미 팀 멤버이거나 역할이 있는 경우 幂等하게 처리 (GitHub/Discord API 모두 PUT 방식으로 멱등성 보장)
