/**
 * 리트코드 스터디 모범 리뷰 칭찬 메시지를 로컬에서 미리 만들어 본다.
 *
 * 수집과 메시지 생성까지만 하고 **Discord 에는 아무것도 올리지 않는다.**
 * 실제 스레드를 만들기 전에 집계와 문장 품질을 눈으로 확인하는 용도다.
 *
 *   npm run preview:praise                                # 수집 + 메시지 생성
 *   npm run preview:praise -- --collect                   # 수집만 (Claude 호출 없음 = 비용 0)
 *   npm run preview:praise -- --context                   # 모델에 넘어가는 집계 결과까지 출력
 *   npm run preview:praise -- --at 2026-10-05T00:00:00Z   # 그 시각에 cron 이 돌았다고 보고 실행
 */
import { collectReviewPraise } from "../src/index.js";
import { generateSummary } from "../src/claude.js";
import { splitForDiscord } from "../src/daleui.js";
import { PRAISE_SYSTEM_PROMPT, buildPraisePrompt, buildPraiseStarter } from "../src/praise.js";
import type { Env } from "../src/types.js";
import { readWranglerVars } from "./wrangler-vars.js";

/** 수집에 필요한 시크릿 — .dev.vars 에서 온다. */
const COLLECT_SECRETS = ["DISCORD_TOKEN", "GITHUB_APP_PRIVATE_KEY"];

const collectOnly = process.argv.includes("--collect");
const showContext = process.argv.includes("--context");
const atIndex = process.argv.indexOf("--at");
const referenceMs = atIndex > -1 ? Date.parse(process.argv[atIndex + 1]) : Date.now();

if (Number.isNaN(referenceMs)) {
  console.error("--at 뒤에는 ISO 시각을 적어주세요. (예: 2026-10-05T00:00:00Z)");
  process.exit(1);
}

// --collect 모드는 모델을 부르지 않으므로 게이트웨이 토큰 없이도 돌려볼 수 있다.
const required = collectOnly ? COLLECT_SECRETS : [...COLLECT_SECRETS, "AI_GATEWAY_TOKEN"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`.dev.vars 에 다음 값이 없습니다: ${missing.join(", ")}`);
  console.error("`.dev.vars.example` 을 복사해 채운 뒤 다시 실행해주세요.");
  process.exit(1);
}

// process.env 가 wrangler.jsonc 를 덮어쓴다.
const env = { ...readWranglerVars(), ...process.env } as unknown as Env;

const collection = await collectReviewPraise(env, referenceMs);
if (!collection) {
  console.log("최근 7일 안에 병합된 풀이 PR이 없어 건너뜁니다. (기수 사이)");
  process.exit(0);
}

console.log("\n" + "─".repeat(60));
console.log(`주차   : WEEK ${collection.week}`);
console.log(`PR     : ${collection.prCount}개`);
console.log(`원문   : ${collection.context.length.toLocaleString()}자`);
console.log("─".repeat(60));

if (showContext) {
  console.log("\n=== 모델에 넘어가는 집계 결과 ===\n");
  console.log(collection.context);
}

if (collectOnly) {
  console.log("\n--collect 모드라 메시지는 생성하지 않았습니다.");
  process.exit(0);
}

const message = await generateSummary(
  PRAISE_SYSTEM_PROMPT,
  buildPraisePrompt(collection.context),
  env.AI_GATEWAY_TOKEN,
);

const chunks = splitForDiscord(message);

console.log("\n=== 채널 시작 메시지 ===\n");
console.log(buildPraiseStarter(collection.week, collection.cohortRoleId));

console.log("\n=== 스레드에 게시될 내용 ===\n");
chunks.forEach((chunk, i) => {
  console.log(`┌─ 메시지 ${i + 1}/${chunks.length} (${chunk.length}자)`);
  console.log(chunk);
  console.log("└" + "─".repeat(59) + "\n");
});

console.log("Discord 에는 아무것도 게시하지 않았습니다.");
