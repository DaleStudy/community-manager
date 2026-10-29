/** 요약 생성에 쓰는 모델 */
const MODEL = "claude-opus-5";

/**
 * 출력 상한. 사고 토큰과 응답 본문을 합쳐 이 값을 넘지 못하므로,
 * 멤버 수가 늘어 요약이 길어지면 함께 올려야 한다.
 */
const MAX_TOKENS = 16000;

const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Worker 와 같은 계정(dalestudy)의 게이트웨이. AI 바인딩으로 부르므로 인증 토큰이 없고,
 * Anthropic 키는 게이트웨이에 BYOK 로 저장돼 있다. 게이트웨이가 BYOK only 라 키가 빠지면
 * Unified Billing 으로 넘어가지 않고 실패한다.
 */
const GATEWAY_ID = "dalestudy";

/**
 * 재시도는 게이트웨이에 맡긴다. Worker 안에서 돌리면 CPU 예산을 깎지만,
 * 엣지에서 재시도하면 응답을 기다리는 시간일 뿐이라 CPU 를 쓰지 않는다.
 */
const RETRY_HEADERS = {
  "cf-aig-max-attempts": 3,
  "cf-aig-retry-delay": 1000,
  "cf-aig-backoff": "exponential",
};

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
  ai: Ai,
): Promise<string> {
  const response = await ai.gateway(GATEWAY_ID).run({
    provider: "anthropic",
    endpoint: "v1/messages",
    headers: {
      "content-type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
      ...RETRY_HEADERS,
    },
    query: {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    },
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
