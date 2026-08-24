# Community Manager Bot

Discord slash command `/verify <github_username>` → GitHub 후원 확인 → GitHub 팀 초대 + Discord 역할 부여

리트코드 스터디 운영 자동화 프로세스를 위한 Discord 봇입니다.

## 개요

DaleStudy 커뮤니티 운영을 자동화하는 Cloudflare Worker 기반 Discord 봇입니다. 하나의 Worker가 세 가지 작업을 처리합니다.

1. **`/verify` 슬래시 명령**: 사용자의 GitHub 후원 여부를 확인해, 후원자인 경우 GitHub 조직 팀에 초대하고 Discord 역할(Role)을 부여합니다.
2. **리트코드 스터디 가입 처리** (cron, 20분 주기): 스터디 신청 포럼에 올라온 글을 폴링해 위 검증 로직을 자동 적용합니다.
3. **블로그 발행 체크** (cron, 매주 월요일 09:00 KST): `blog` 역할 대상자가 이번 주 블로그를 발행(블로그글-공유 포럼에 게시글 작성)했는지 확인해 리포트와 새 주 시작 안내를 올리고, 베스트 글 선정용 순위표를 운영진 채널에 게시합니다.
4. **달레UI 주간 업데이트** (cron, 매주 토요일 08:00 KST): 디자인시스템 팀의 주간 회의(09:30) 전에 GitHub(이슈·PR·코멘트·프로젝트 보드)과 Discord 활동을 취합해 개인 업데이트 스레드를 만들고 멤버별 요약을 게시합니다. 요약 작성은 Claude API가 맡습니다.

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

위 그림은 `/verify` 인터랙션(`fetch` 핸들러) 흐름입니다. 이와 별개로, 봇은 **Cron Trigger로 세 가지 작업**을 `scheduled` 핸들러에서 주기적으로 실행하며 `event.cron` 값으로 분기합니다.

```
Cloudflare Cron ──► Worker.scheduled(event.cron)
   */20 * * * *  ──► handleLeetCodeSignUp       (신청 포럼 폴링 → 후원 검증 재사용)
   0 0 * * MON   ──► handleBlogPublishCheck     (발행 체크 → 리포트 + 새 스레드 / 순위표 → 운영진 채널)
   0 23 * * FRI  ──► handleDaleuiWeeklyUpdate   (활동 수집 → Claude 요약 → 스레드 생성 + 게시)
```

달레UI 주간 업데이트는 **수집과 판단을 분리**합니다. 무엇이 있었는지(이슈·PR·코멘트·보드 상태·채널 대화)는 코드가 모으고, 무엇이 완료·주의·위험인지와 멤버별 기여 순서는 Claude가 정합니다.

```
handleDaleuiWeeklyUpdate
   │
   ├─ 역할 멤버 조회 → 매핑 대조 (신규 합류자도 누락하지 않음)
   ├─ 직전 업데이트 스레드 → 취합 기간 결정 (없으면 최근 7일)
   │
   ├─ 병렬 수집 ─┬─ GitHub 이슈·PR      (daleui, daleui.com)
   │             ├─ GitHub 코멘트·리뷰
   │             ├─ 프로젝트 보드        (projectV2 GraphQL)
   │             ├─ 최신 Sprint 회의 이슈 (스레드 제목)
   │             └─ Discord 채널 대화
   │
   ├─ Claude API (claude-opus-5) → 멤버별 요약
   │
   └─ 시작 메시지(역할 멘션 1회) → 스레드 생성 → 2000자 단위 분할 게시
```

## 기술 스택

| Layer         | Technology                                                              |
| ------------- | ----------------------------------------------------------------------- |
| Runtime       | Cloudflare Workers (TypeScript)                                         |
| Slash Command | Discord Interactions API                                                |
| 후원 확인     | GitHub GraphQL API (`sponsorshipsAsMaintainer`)                         |
| 팀 초대       | GitHub REST API (`PUT /orgs/{org}/teams/{team}/memberships/{username}`) |
| 역할 부여     | Discord REST API (`PUT /guilds/{guild}/members/{user}/roles/{role}`)    |
| 주간 요약     | Claude API (`claude-opus-5`, `@anthropic-ai/sdk`) via Cloudflare AI Gateway |
| 프로젝트 보드 | GitHub GraphQL API (`projectV2`)                                        |
| 배포          | Wrangler CLI                                                            |

## 프로젝트 구조

```
community-manager/
├── src/
│   ├── index.ts          # Cloudflare Worker entry point
│   ├── discord.ts        # Discord 서명 검증, API 호출
│   ├── github.ts         # GitHub GraphQL/REST API 호출
│   ├── blog.ts           # 블로그 발행 체크 로직 (KST 주간 경계·발행 상태 분류·베스트 글 순위)
│   ├── daleui.ts         # 달레UI 주간 업데이트 로직 (취합 기간·컨텍스트 구성·요약 프롬프트·메시지 분할)
│   ├── claude.ts         # Claude API 호출 (멤버별 요약 생성)
│   └── types.ts          # 공통 타입 정의
├── scripts/
│   ├── register-commands.ts # Discord slash command 등록 (npm run register)
│   └── preview-daleui.ts    # 달레UI 주간 업데이트 로컬 미리보기 (게시하지 않음)
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
| `AI_GATEWAY_TOKEN`           | AI Gateway 통과용 토큰 (달레UI 주간 요약)  |

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
| `ADMIN_CHANNEL_ID`      | 베스트 글 순위표를 올릴 운영진 채널 ID      |
| `DALEUI_CHANNEL_ID`     | 달레UI 주간 업데이트: 스레드를 만들 디자인시스템 채널 ID |
| `DALEUI_ROLE_ID`        | 달레UI 주간 업데이트: 대상 `designsystem` 역할 ID |
| `DALEUI_PROJECT_NUMBER` | 달레UI 주간 업데이트: 프로젝트 보드(projectV2) 번호 |
| `DALEUI_MEMBER_MAP`     | 달레UI 주간 업데이트: Discord ID ↔ GitHub 핸들 매핑 (JSON) |

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

- 판정 결과와 새 주 시작 안내를 리포트 채널(`BLOG_STUDY_CHANNEL_ID`)에 게시합니다.

#### 베스트 글 순위표

같은 주간 창의 게시글에 달린 반응과 댓글로 점수를 매겨 상위 5개를 **운영진 채널(`ADMIN_CHANNEL_ID`)** 에 게시합니다. **선정이 아니라 집계**이며, 운영진이 이 중에서 베스트 글을 직접 고릅니다.

| 지표 | 점수 | 집계 방식 |
|---|---|---|
| 반응 | 1점 | 고유 반응자 수 — 한 사람이 이모지를 여러 개 눌러도 1명 |
| 댓글 | 3점 | 댓글 수 — 반응보다 희소해서 더 무겁게 침 |

- **작성자 본인과 봇의 반응·댓글은 제외**합니다. 자문자답으로 점수를 올릴 수 없습니다.
- `blog` 역할 보유자의 글만 순위 대상입니다. 발행 체크 대상과 같은 기준이라, 운영진이 올리는 안내 글은 자연히 빠집니다.
- 동점이면 반응자가 많은 글이, 그래도 같으면 먼저 올라온 글이 앞섭니다. 늦게 올린 글이 반응을 모을 시간이 짧은 점은 보정하지 않습니다.
- 아직 확정 전 초안이므로 멘션은 이름으로 보이기만 하고 **당사자에게 알림이 가지 않습니다**.

> 주간 판정 창(지난 월 09:00 ~ 이번 월 09:00), 분류·점수 로직은 [`src/blog.ts`](src/blog.ts)에 있고, 경계와 순위 규칙은 단위 테스트([`src/blog.test.ts`](src/blog.test.ts))로 검증합니다.

### 달레UI 주간 업데이트 (주간 cron)

매주 토요일 08:00 KST(`0 23 * * FRI`)에 실행되어, 디자인시스템 팀의 주간 회의(09:30) 전에 개인 업데이트 스레드를 만듭니다. 멤버들은 빈 칸을 채우는 대신 **누락되거나 틀린 부분만 정정**하면 됩니다.

#### 취합 기간

직전 업데이트 스레드가 만들어진 시점부터 지금까지입니다. 스레드를 못 찾으면 최근 7일로 되돌아갑니다. 같은 활동을 두 주 연속 올리지 않기 위한 기준입니다.

#### 수집하는 것

| 소스 | 조회 | 왜 보는가 |
|---|---|---|
| GitHub 이슈·PR | `/repos/{org}/{repo}/issues?since=` | 한 번의 조회로 이슈와 PR을 함께 얻고 `pull_request` 필드로 구분합니다 |
| GitHub 코멘트·리뷰 | `/issues/comments`, `/pulls/comments` | 자가 보고에 안 잡히는 설계 제안·기술 피드백이 여기서 나옵니다 |
| 프로젝트 보드 | `projectV2` GraphQL | 활동 흔적만으로는 안 보이는 미착수·정체 항목이 드러납니다 |
| Discord 채널 | 최근 30개 메시지 | 회의 시간 변경 같은 채널 내 결정을 잡습니다 |

`daleui`와 `daleui.com` 두 저장소를 봅니다. 역할 멤버는 매번 다시 조회해 탈퇴·합류 변동을 반영하며, 매핑 표에 없는 신규 멤버도 GitHub 핸들 없이 포함해 통째로 누락되지 않게 합니다.

#### 요약 생성

수집한 원자료를 Claude(`claude-opus-5`)에 넘겨 멤버별 요약을 받습니다. **무엇이 완료·주의·위험인지, 누가 이번 주에 더 기여했는지는 규칙으로 환원되지 않아** 모델이 판단합니다. 코드는 수집과 게시만 맡습니다.

호출은 [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/)를 거칩니다. Messages API에 `fetch`로 POST 한 번이 전부라 SDK는 쓰지 않습니다.

```
https://gateway.ai.cloudflare.com/v1/{계정 ID}/dalestudy/anthropic/v1/messages
```

- 상태 아이콘은 ✅ 완료 · ▶️ 진행 · ⚠️ 주의 · 🚨 위험 네 가지만 씁니다.
- 활동이 안 잡히는 멤버는 지어내지 않고 "이번 주 확인된 기여 없음"으로 명시합니다.
- 요약이 잘렸거나(`max_tokens`) 비었으면 게시하지 않고 실패합니다.

#### 게시

역할 멘션은 **채널의 스레드 시작 메시지에 한 번만** 등장하고, 스레드 안에서는 개인 멘션만 씁니다. 멘션 위치가 알림 범위를 결정하기 때문입니다. 요약이 Discord 메시지 상한(2000자)을 넘으면 멤버 구분자인 H3 헤더 경계에서 나눠 한 사람의 요약이 두 메시지에 걸치지 않게 합니다.

> 취합 기간 계산, 컨텍스트 구성, 요약 프롬프트, 메시지 분할은 [`src/daleui.ts`](src/daleui.ts)에 순수 함수로 있고 단위 테스트([`src/daleui.test.ts`](src/daleui.test.ts))로 검증합니다. Claude 호출은 [`src/claude.ts`](src/claude.ts)에 격리되어 있어 요약 품질과 무관하게 수집 로직을 검증할 수 있습니다.

#### 로컬에서 미리 보기

게시 직전까지만 실행해 요약을 콘솔에 출력합니다. **Discord에는 아무것도 올라가지 않습니다.**

```bash
npm run preview:daleui             # 수집 + 요약 생성
npm run preview:daleui -- --collect # 수집만 (Claude 호출 없음 = 비용 0)
npm run preview:daleui -- --context # 모델에 넘어가는 원문까지 출력
```

`.dev.vars`에 `GITHUB_APP_ID`·`GITHUB_APP_INSTALLATION_ID`·`GITHUB_APP_PRIVATE_KEY`가 필요하고, 요약까지 보려면 `AI_GATEWAY_TOKEN`도 필요합니다. 채널·역할 ID 같은 공개값은 `wrangler.jsonc`에서 읽되 `.dev.vars`가 있으면 그쪽이 우선하므로, 테스트 서버 값으로 덮어써서 돌려볼 수 있습니다.

게시까지 포함한 전체 흐름을 확인하려면 `.dev.vars`에서 `DISCORD_GUILD_ID`·`DALEUI_CHANNEL_ID`·`DALEUI_ROLE_ID`를 테스트 서버 값으로 바꾼 뒤 실행합니다.

```bash
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+23+*+*+FRI"
```

> ⚠️ 오버라이드 없이 `wrangler dev`로 cron을 트리거하면 **운영 채널에 실제로 게시되고 역할 멘션이 발송됩니다.** 로컬이라고 해서 Discord 호출이 막히지는 않습니다.

## 라이선스

이 프로젝트는 MIT 라이선스를 따릅니다.
