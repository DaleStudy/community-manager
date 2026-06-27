# Community Manager Bot — Implementation Plan

## Overview

Discord slash command `/verify <github_username> <role> <team>` → GitHub 후원 확인 → GitHub 팀 초대 + Discord 역할 부여

---

## Architecture

```
Discord User
    │
    │  /verify <github_username> <role> <team>
    ▼
Discord API
    │
    │  POST (Interaction Webhook)
    ▼
Cloudflare Worker
    │
    │  ROLE_TEAM_CONFIG에서 role/team 매핑 조회
    │  GraphQL: isSponsoredBy(org)
    ▼
GitHub API (Sponsors)
    │
    ├─ 후원 O ──► GitHub REST API (팀 초대)
    │
    └─ 후원 O ──► Discord REST API (역할 부여)
```

---

## Tech Stack

| Layer         | Technology                                                              |
| ------------- | ----------------------------------------------------------------------- |
| Runtime       | Cloudflare Workers (TypeScript)                                         |
| Slash Command | Discord Interactions API                                                |
| 후원 확인     | GitHub GraphQL API (`isOrganizationSponsoredBy`)                        |
| 팀 초대       | GitHub REST API (`PUT /orgs/{org}/teams/{team}/memberships/{username}`) |
| 역할 부여     | Discord REST API (`PUT /guilds/{guild}/members/{user}/roles/{role}`)    |
| 배포          | Wrangler CLI / GitHub Actions                                           |

---

## Command Design

```
/verify
  github_username: string (필수)
  role: choices (필수) — ROLE_TEAM_CONFIG의 label/value로 자동 생성
  team: choices (필수) — ROLE_TEAM_CONFIG의 label/value로 자동 생성
```

- `role`과 `team`은 Discord 드롭다운 선택지로 표시됨
- 선택지는 `ROLE_TEAM_CONFIG`에서 정의하며, 변경 시 `register.ts` 재실행 필요

---

## Step-by-Step Flow

### 1. Discord Interaction 수신

- Cloudflare Worker가 Discord Interaction Webhook을 수신
- `Ed25519` 서명 검증 (필수 — 실패 시 Discord가 endpoint를 비활성화함)
- Interaction type `PING(1)` → 즉시 `PONG` 응답
- Interaction type `APPLICATION_COMMAND(2)` → 처리 시작

### 2. 파라미터 파싱 및 매핑 조회

- `options`에서 `github_username`, `role`, `team` 추출
- `ROLE_TEAM_CONFIG` JSON 파싱 후 `role` 값으로 `discordRoleId` 조회, `team` 값으로 `teamSlug` 조회

### 3. Deferred Response 반환

- GitHub API 호출이 3초를 초과할 수 있으므로, 즉시 `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE(5)` 반환
- 이후 처리 결과를 `followup` 메시지로 전송

### 4. GitHub 후원 확인

- GitHub GraphQL API로 `<github_username>`이 조직을 후원하는지 확인

```graphql
query {
  user(login: "<github_username>") {
    isSponsoredBy(accountLogin: "<org_name>")
  }
}
```

### 5. GitHub 팀 초대

- 후원 확인 시 GitHub REST API로 팀 멤버십 추가

```
PUT /orgs/{org}/teams/{teamSlug}/memberships/{username}
Body: { "role": "member" }
```

### 6. Discord 역할 부여

- Discord REST API로 명령어를 실행한 유저에게 역할 추가

```
PUT /guilds/{guild_id}/members/{user_id}/roles/{discordRoleId}
```

### 7. Followup 메시지 전송

- 성공: "✅ 후원이 확인되었습니다. GitHub 팀과 Discord 역할이 부여되었습니다."
- 후원 없음: "❌ 해당 GitHub 계정의 후원 내역을 찾을 수 없습니다."
- 오류: "⚠️ 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요."

---

## Project Structure

```
community-manager/
├── src/
│   ├── index.ts          # Cloudflare Worker entry point
│   ├── discord.ts        # Discord 서명 검증, API 호출
│   ├── github.ts         # GitHub GraphQL/REST API 호출
│   └── types.ts          # 공통 타입 정의 (RoleTeamConfig, Env 등)
├── scripts/
│   └── register.ts       # Discord slash command 등록 스크립트
├── .github/
│   └── workflows/
│       └── deploy.yml    # GitHub Actions CI/CD
├── wrangler.jsonc         # Cloudflare Worker 설정
├── package.json
└── tsconfig.json
```

---

## Configuration

### `wrangler.jsonc` vars (공개값, 커밋됨)

| Key               | 설명                                                              |
| ----------------- | ----------------------------------------------------------------- |
| `GITHUB_ORG`      | GitHub 조직 이름                                                  |
| `ROLE_TEAM_CONFIG`| role/team 매핑 JSON 배열 (value, label, discordRoleId, teamSlug) |

#### ROLE_TEAM_CONFIG 형식

```json
[
  {
    "value": "leetcode",
    "label": "LeetCode Study",
    "discordRoleId": "123456789",
    "teamSlug": "leetcode-team"
  }
]
```

### Cloudflare Secrets (운영진만 접근)

| Key                  | 설명                                       |
| -------------------- | ------------------------------------------ |
| `DISCORD_PUBLIC_KEY` | Discord App의 Ed25519 공개키 (서명 검증용) |
| `DISCORD_TOKEN`      | Discord Bot Token                          |
| `DISCORD_GUILD_ID`   | 대상 Discord 서버 ID                       |
| `APP_ID`             | GitHub App ID                              |
| `APP_INSTALLATION_ID`| GitHub App의 조직 Installation ID          |
| `APP_PRIVATE_KEY`    | GitHub App Private Key (PEM 형식)          |

---

## Implementation Tasks

- [x] 1. 프로젝트 초기 세팅 (Wrangler, TypeScript, package.json)
- [x] 2. Cloudflare Worker 진입점 및 라우팅 구현 (index.ts)
- [x] 3. role/team 파라미터 파싱 및 ROLE_TEAM_CONFIG 매핑 조회
- [x] 4. GitHub GraphQL 후원 확인 구현 (github.ts)
- [ ] 5. GitHub REST API 팀 초대 구현 (github.ts)
- [ ] 6. Deferred response + followup 메시지 흐름 구현
- [ ] 7. 환경변수 설정 및 Cloudflare 배포 / Worker end-to-end 검증
- [ ] 8. Discord slash command 등록 스크립트 작성 (scripts/register.ts)
- [ ] 9. Ed25519 서명 검증 구현 (index.ts)
- [ ] 10. Discord REST API 역할 부여 구현 (discord.ts)
- [ ] 11. Discord Bot 권한 설정 및 end-to-end 테스트

---

## Key Considerations

- **서명 검증**: Discord는 응답 속도와 무관하게 서명 검증 실패 시 webhook endpoint를 차단함. Web Crypto API (`SubtleCrypto`) 사용 필수
- **응답 시간**: Discord Interaction은 3초 내 응답 필요 → Deferred Response 패턴 필수
- **ROLE_TEAM_CONFIG**: wrangler.jsonc에 JSON 문자열로 저장. 선택지 추가/변경 시 register.ts 재실행 필요
- **GitHub App 권한**: 후원 확인(GraphQL)과 팀 초대(REST) 모두 처리
- **Bot 역할 위치**: Discord에서 Bot이 부여할 역할보다 높은 위치에 있어야 함
- **중복 실행 방지**: PUT 방식으로 멱등성 보장
