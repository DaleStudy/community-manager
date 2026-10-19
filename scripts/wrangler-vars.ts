import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * wrangler.jsonc 의 vars 를 읽는다. 로컬 실행에는 wrangler 가 값을 주입해주지 않으므로
 * 같은 파일을 직접 읽어 쓴다. 주석과 trailing comma 만 걷어내면 JSON 으로 파싱된다.
 */
export function readWranglerVars(): Record<string, string> {
  const raw = readFileSync(join(here, "..", "wrangler.jsonc"), "utf8");
  const json = raw
    .replace(/^\s*\/\/.*$/gm, "") // 줄 전체 주석
    .replace(/,(\s*[}\]])/g, "$1"); // trailing comma
  return JSON.parse(json).vars ?? {};
}
