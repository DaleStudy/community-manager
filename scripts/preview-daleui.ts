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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { collectDaleuiUpdate } from "../src/index.js";
import { generateSummary } from "../src/claude.js";
import { SUMMARY_SYSTEM_PROMPT, buildUserPrompt, splitForDiscord } from "../src/daleui.js";
import type { Env } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * wrangler.jsonc 의 vars 를 읽는다. 로컬 실행에는 wrangler 가 값을 주입해주지 않으므로
 * 같은 파일을 직접 읽어 쓴다. 주석과 trailing comma 만 걷어내면 JSON 으로 파싱된다.
 */
function readWranglerVars(): Record<string, string> {
  const raw = readFileSync(join(here, "..", "wrangler.jsonc"), "utf8");
  const json = raw
    .replace(/^\s*\/\/.*$/gm, "") // 줄 전체 주석
    .replace(/,(\s*[}\]])/g, "$1"); // trailing comma
  return JSON.parse(json).vars ?? {};
}

/** 수집에 필요한 시크릿 — .dev.vars 에서 온다. */
const COLLECT_SECRETS = [
  "DISCORD_TOKEN",
  "DISCORD_GUILD_ID",
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY",
];

const collectOnly = process.argv.includes("--collect");
const showContext = process.argv.includes("--context");

// --collect 모드는 모델을 부르지 않으므로 게이트웨이 토큰 없이도 돌려볼 수 있다.
const required = collectOnly ? COLLECT_SECRETS : [...COLLECT_SECRETS, "AI_GATEWAY_TOKEN"];
const missing = required.filter((key) => !process.env[key]);
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

const summary = await generateSummary(
  SUMMARY_SYSTEM_PROMPT,
  buildUserPrompt(collection.context),
  env.AI_GATEWAY_TOKEN,
);

const chunks = splitForDiscord(summary);

console.log("\n=== 게시될 내용 ===\n");
chunks.forEach((chunk, i) => {
  console.log(`┌─ 메시지 ${i + 1}/${chunks.length} (${chunk.length}자)`);
  console.log(chunk);
  console.log("└" + "─".repeat(59) + "\n");
});

console.log("Discord 에는 아무것도 게시하지 않았습니다.");
