## Code Review Rules

- Cloudflare Workers 런타임이다. Node.js 내장 모듈에 의존하는 코드는 지적한다.
- cron을 추가하거나 바꾸면 `wrangler.jsonc`의 `triggers.crons`와 `src/index.ts`의 `scheduled` 분기가 함께 바뀌어야 한다. 분기에 없는 cron은 `else`로 빠져 가입 처리가 실행된다.
- Discord에 올리는 긴 텍스트는 2000자 제한을 넘지 않도록 `splitForDiscord`를 거쳐야 한다.
- 역할 멘션은 스레드 시작 메시지에서 한 번만 한다. 분할 메시지나 반복문 안에서 역할을 멘션하면 지적한다.
- GitHub 팀 초대나 Discord 역할 부여 경로에서 후원 확인을 건너뛸 수 있는 변경은 심각한 문제로 지적한다.
- 새 로직에는 같은 이름의 `*.test.ts`가 옆에 있어야 한다.

## 관련 문서

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [GitHub Apps API](https://docs.github.com/en/apps)
- [GitHub GraphQL API](https://docs.github.com/en/graphql)
- [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
