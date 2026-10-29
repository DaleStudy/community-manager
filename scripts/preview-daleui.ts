/**
 * 달레UI 주간 업데이트를 로컬에서 미리 만들어 본다.
 *
 * 수집과 요약 생성까지만 하고 **Discord 에는 아무것도 올리지 않는다.**
 * 실제 스레드를 만들기 전에 요약 품질을 눈으로 확인하는 용도다.
 *
 *   npm run preview:daleui              # 수집 + 요약 생성
 *   npm run preview:daleui -- --collect # 수집만 (Claude 호출 없음 = 비용 0)
 *   npm run preview:daleui -- --context # 모델에 넘어가는 원문까지 출력
 */
import { getPlatformProxy } from "wrangler";
import { readWranglerVars } from "./wrangler-vars.js";
import { collectDaleuiUpdate } from "../src/index.js";
import { generateSummary } from "../src/claude.js";
import { SUMMARY_SYSTEM_PROMPT, buildUserPrompt } from "../src/daleui.js";
import { splitForDiscord } from "../src/discord.js";
import type { Env } from "../src/types.js";

/** 수집에 필요한 시크릿 — .dev.vars 에서 온다. */
const COLLECT_SECRETS = ["DISCORD_TOKEN", "GITHUB_APP_PRIVATE_KEY"];

const collectOnly = process.argv.includes("--collect");
const showContext = process.argv.includes("--context");

const missing = COLLECT_SECRETS.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`.dev.vars 에 다음 값이 없습니다: ${missing.join(", ")}`);
  console.error("`.dev.vars.example` 을 복사해 채운 뒤 다시 실행해주세요.");
  process.exit(1);
}

// process.env 가 wrangler.jsonc 를 덮어쓴다. .dev.vars 에서 채널·역할 ID 를
// 테스트 서버 값으로 바꿔 실제 서버를 건드리지 않고 돌려볼 수 있다.
const env = { ...readWranglerVars(), ...process.env } as unknown as Env;

const collection = await collectDaleuiUpdate(env, Date.now());

console.log("\n" + "─".repeat(60));
console.log(`회의   : ${collection.meetingTitle}`);
console.log(`기간   : ${collection.period}`);
console.log(`멤버   : ${collection.memberCount}명`);
console.log(`원문   : ${collection.context.length.toLocaleString()}자`);
console.log("─".repeat(60));

if (showContext) {
  console.log("\n=== 모델에 넘어가는 원문 ===\n");
  console.log(collection.context);
}

if (collectOnly) {
  console.log("\n--collect 모드라 요약은 생성하지 않았습니다.");
  process.exit(0);
}

// wrangler.jsonc 의 AI 바인딩을 원격 게이트웨이에 연결한다. wrangler login 이 필요하다.
const platform = await getPlatformProxy<Pick<Env, "AI">>();
const summary = await generateSummary(
  SUMMARY_SYSTEM_PROMPT,
  buildUserPrompt(collection.context),
  platform.env.AI,
);
await platform.dispose();

const chunks = splitForDiscord(summary);

console.log("\n=== 게시될 내용 ===\n");
chunks.forEach((chunk, i) => {
  console.log(`┌─ 메시지 ${i + 1}/${chunks.length} (${chunk.length}자)`);
  console.log(chunk);
  console.log("└" + "─".repeat(59) + "\n");
});

console.log("Discord 에는 아무것도 게시하지 않았습니다.");
