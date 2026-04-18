- /verify를 해서 사용자 추가 로직을 탈때, 이미 가입되어 있는 사용자인 경우에는 이미 가입되어 있는 사용자라는 메세지로 응답하도록 개선 필요
- 후원 체크를 할때 최근에 후원한 정보만 갖고와서 팀의 생성 날짜와 비교를 하고 있는데, 팀 생성 날짜 이후에 후원한 기록을 모두 갖고와서 금액을 sum 하도록 로직 수정 필요

## 스터디 채널 메시지 기반 자동 가입 처리 (CF Worker Cron)

### 아이디어
현재 `/verify` 슬래시 커맨드 외에, Discord의 특정 채널(예: `#study-join`)에 사용자가 메시지를 포스팅하면 동일한 로직(후원 체크 → GitHub 팀 초대 → Discord 역할 부여)이 자동으로 실행되도록 한다.

실시간 처리가 아니어도 되며, 20분마다 또는 하루 1회 Cron으로 실행해도 충분.

### 구현 방식: CF Worker Cron Trigger + Discord REST API 폴링

별도 서버 없이 기존 CF Worker에 `scheduled` 핸들러를 추가하는 방식.

**흐름:**
1. Cron 실행 (예: 20분마다 `*/20 * * * *`)
2. Discord REST API로 `#study-join` 채널의 최근 메시지 조회
   - `GET /channels/{channelId}/messages`
3. Bot의 ✅ reaction이 없는 메시지만 필터링 (미처리 메시지 판별)
4. 메시지 내용 파싱 (github_username, team, role 추출)
5. 기존 `handleVerify` 핵심 로직 실행
6. 결과를 해당 메시지에 Reply로 전송
7. ✅ reaction 추가 (처리 완료 표시, 중복 처리 방지)

### 필요한 작업

- [ ] `wrangler.toml`에 cron 트리거 추가
  ```toml
  [triggers]
  crons = ["*/20 * * * *"]
  ```
- [ ] `index.ts`에 `scheduled` 핸들러 추가
- [ ] `handleVerify` 핵심 로직을 별도 함수로 분리 (slash command, cron 양쪽에서 재사용)
- [ ] `handleChannelJoin` 함수 구현 (메시지 조회 → 파싱 → 처리 → reaction 추가)
- [ ] `discord.ts`에 채널 메시지 조회, Reply 전송, Reaction 추가 함수 추가
- [ ] `Env` 타입에 `STUDY_JOIN_CHANNEL_ID` 추가
- [ ] `.dev.vars.example`에 `STUDY_JOIN_CHANNEL_ID` 추가
- [ ] 채널 메시지 포맷 결정 (사용자가 어떤 형식으로 작성할지 정의 필요)

### 채널 메시지 포맷 (미정, 논의 필요)
사용자가 `#study-join` 채널에 올릴 메시지 형식을 정해야 함. 예시:
```
github: torvalds
team: algo
role: member
```

### 트레이드오프
- 응답 지연 최대 20분 (허용 가능)
- 추가 서버 불필요, 기존 CF Worker만 사용
- Reaction 방식으로 별도 DB/KV 없이 처리 여부 관리 가능
