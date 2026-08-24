/** 요약 생성에 쓰는 모델 */
const MODEL = "claude-opus-5";

/**
 * 출력 상한. 사고 토큰과 응답 본문을 합쳐 이 값을 넘지 못하므로,
 * 멤버 수가 늘어 요약이 길어지면 함께 올려야 한다.
 */
const MAX_TOKENS = 16000;

const ANTHROPIC_VERSION = "2023-06-01";

/** 게이트웨이가 있는 Cloudflare 계정. 배포 계정(wrangler.jsonc 의 account_id)과 다르다. */
const GATEWAY_ACCOUNT_ID = "86aa227176a624680f7d34e691472576";
const GATEWAY_ID = "dalestudy";

/**
 * AI Gateway 를 거치는 Anthropic Messages 엔드포인트.
 *
 * 게이트웨이 ID 가 경로에 들어가므로 어느 게이트웨이로 갔는지 URL 만 보면 알 수 있다.
 * (Unified Billing REST 경로는 `cf-aig-gateway-id` 헤더를 빠뜨리면 default 게이트웨이로
 * 조용히 흘러가지만, 이 경로는 그런 함정이 없다.)
 */
const ENDPOINT = `https://gateway.ai.cloudflare.com/v1/${GATEWAY_ACCOUNT_ID}/${GATEWAY_ID}/anthropic/v1/messages`;

/** Anthropic Messages API 응답 중 실제로 쓰는 부분만 */
interface MessagesResponse {
  content: Array<{ type: string; text?: string }>;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * 수집한 활동 흔적을 멤버별 요약으로 바꾼다.
 * 무엇이 완료이고 무엇이 리스크인지 판단하는 부분이라 규칙 기반 코드로는 대체할 수 없다.
 *
 * 호출은 AI Gateway 를 거친다. 주 1회 실행이라 캐싱이나 속도 제한은 의미가 없지만,
 * 사람이 지켜보지 않는 자동 실행이라 요청·토큰·지연이 대시보드에 남는 편이 낫다.
 */
export async function generateSummary(
  systemPrompt: string,
  userPrompt: string,
  gatewayToken: string,
): Promise<string> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
      // 인증이 켜진 게이트웨이는 이 헤더가 없으면 게이트웨이 존재 여부도 알려주지 않고 401 을 낸다.
      "cf-aig-authorization": `Bearer ${gatewayToken}`,
      // 재시도는 게이트웨이에 맡긴다. Worker 안에서 돌리면 CPU 예산을 깎지만,
      // 엣지에서 재시도하면 응답을 기다리는 시간일 뿐이라 CPU 를 쓰지 않는다.
      "cf-aig-max-attempts": "3",
      "cf-aig-retry-delay": "1000",
      "cf-aig-backoff": "exponential",
      // x-api-key 는 보내지 않는다. 게이트웨이가 저장된 키(BYOK)를 끼워 넣는데,
      // 요청에 키가 실려 있으면 그대로 전달돼 401 이 난다.
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`요약 생성 실패 (${response.status}): ${await response.text()}`);
  }

  const data = (await response.json()) as MessagesResponse;

  if (data.stop_reason === "refusal") {
    throw new Error("모델이 요약 생성을 거부했습니다");
  }

  const text = data.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();

  if (!text) {
    throw new Error(`요약이 비어 있습니다 (stop_reason=${data.stop_reason})`);
  }

  console.log(
    `[daleui] 요약 생성 완료 stop_reason=${data.stop_reason} ` +
      `입력=${data.usage.input_tokens} 출력=${data.usage.output_tokens} 길이=${text.length}`,
  );

  // 사고가 길어져 본문이 잘렸을 수 있다. 잘린 요약을 그대로 올리지 않는다.
  if (data.stop_reason === "max_tokens") {
    throw new Error("요약이 max_tokens 에서 잘렸습니다. MAX_TOKENS 를 올려주세요");
  }

  return text;
}
