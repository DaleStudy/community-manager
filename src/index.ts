export default {
  async fetch(request, env, ctx) {
    // 간단한 테스트 응답
    return new Response("Hello World from Community Manager Bot!", {
      headers: { "content-type": "text/plain" },
    });
  },
};
