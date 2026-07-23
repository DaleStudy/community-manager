import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkSponsorship, getInstallationToken, getTeamCreatedAt, inviteToTeam } from "./github.js";
import type { Env } from "./types.js";

const mockEnv: Env = {
  DISCORD_PUBLIC_KEY: "test-public-key",
  DISCORD_TOKEN: "test-bot-token",
  DISCORD_GUILD_ID: "test-guild-id",
  DISCORD_APPLICATION_ID: "test-app-id",
  GITHUB_ORG: "DaleStudy",
  GITHUB_APP_ID: "123456",
  GITHUB_APP_INSTALLATION_ID: "789",
  GITHUB_APP_PRIVATE_KEY: "",
  ROLE_TEAM_CONFIG: "[]",
  GH_PAT: "test-pat",
  STUDY_JOIN_CHANNEL_ID: "test-channel-id",
  BLOG_STUDY_CHANNEL_ID: "test-blog-channel-id",
  BLOG_STUDY_FORUM_ID: "test-blog-forum-id",
  BLOG_STUDY_ROLE_ID: "test-blog-role-id",
};

function makeSponsorshipResponse(
  sponsors: { login: string; createdAt?: string; isOneTimePayment?: boolean; amount?: number }[],
  hasNextPage = false,
  endCursor: string | null = null,
) {
  return {
    json: () =>
      Promise.resolve({
        data: {
          organization: {
            sponsorsActivities: {
              nodes: sponsors.map(({ login, createdAt = "2024-01-01T00:00:00Z", isOneTimePayment = true, amount = 5 }) => ({
                timestamp: createdAt,
                sponsorsTier: { monthlyPriceInDollars: amount, isOneTime: isOneTimePayment },
                sponsor: { login },
              })),
              pageInfo: { hasNextPage, endCursor },
            },
          },
        },
      }),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("checkSponsorship", () => {
  it("후원 이력이 없으면 sponsored: false를 반환한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeSponsorshipResponse([{ login: "someone-else" }])),
    );

    const result = await checkSponsorship("octocat", "DaleStudy", "test-token");
    expect(result).toEqual({ sponsored: false, records: [] });
  });

  it("후원 중인 경우 sponsored: true와 날짜를 반환한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeSponsorshipResponse([{ login: "octocat", createdAt: "2024-06-01T00:00:00Z" }]),
      ),
    );

    const result = await checkSponsorship("octocat", "DaleStudy", "test-token");
    expect(result).toEqual({
      sponsored: true,
      records: [{ createdAt: "2024-06-01T00:00:00Z", isOneTimePayment: true, amount: 5 }],
    });
  });

  it("대소문자 구분 없이 일치하면 sponsored: true를 반환한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeSponsorshipResponse([{ login: "OctoCAT" }])),
    );

    const result = await checkSponsorship("octocat", "DaleStudy", "test-token");
    expect(result.sponsored).toBe(true);
  });

  it("여러 후원 이력 중 가장 최근 날짜를 반환한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(
          makeSponsorshipResponse([
            { login: "octocat", createdAt: "2024-01-01T00:00:00Z" },
          ], true, "cursor1"),
        )
        .mockResolvedValueOnce(
          makeSponsorshipResponse([
            { login: "octocat", createdAt: "2024-09-01T00:00:00Z" },
          ]),
        ),
    );

    const result = await checkSponsorship("octocat", "DaleStudy", "test-token");
    const dates = result.records.map((r) => r.createdAt);
    expect(Math.max(...dates.map((d) => new Date(d).getTime()))).toBe(new Date("2024-09-01T00:00:00Z").getTime());
  });

  it("페이지네이션으로 다음 페이지에서 찾으면 sponsored: true를 반환한다", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        makeSponsorshipResponse([{ login: "alice" }, { login: "bob" }], true, "cursor1"),
      )
      .mockResolvedValueOnce(makeSponsorshipResponse([{ login: "octocat" }]));
    vi.stubGlobal("fetch", mockFetch);

    const result = await checkSponsorship("octocat", "DaleStudy", "test-token");
    expect(result.sponsored).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("모든 페이지 순회 후 없으면 sponsored: false를 반환한다", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        makeSponsorshipResponse([{ login: "alice" }], true, "cursor1"),
      )
      .mockResolvedValueOnce(makeSponsorshipResponse([{ login: "bob" }]));
    vi.stubGlobal("fetch", mockFetch);

    const result = await checkSponsorship("octocat", "DaleStudy", "test-token");
    expect(result.sponsored).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("GraphQL 에러 발생 시 예외를 던진다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            errors: [{ message: "Unauthorized" }],
          }),
      }),
    );

    await expect(
      checkSponsorship("octocat", "DaleStudy", "bad-token"),
    ).rejects.toThrow("GraphQL error");
  });

  it("올바른 GraphQL 엔드포인트와 헤더로 요청한다", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeSponsorshipResponse([{ login: "octocat" }]));
    vi.stubGlobal("fetch", mockFetch);

    await checkSponsorship("octocat", "DaleStudy", "my-token");

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.github.com/graphql");
    expect(options.headers["Authorization"]).toBe("Bearer my-token");
  });

  it("비공개 후원도 포함하도록 includePrivate: true로 요청한다", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeSponsorshipResponse([{ login: "octocat" }]));
    vi.stubGlobal("fetch", mockFetch);

    await checkSponsorship("octocat", "DaleStudy", "my-token");

    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.query).toContain("includePrivate: true");
  });

  it("sponsorsActivities를 NEW_SPONSORSHIP 액션으로 조회한다", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeSponsorshipResponse([{ login: "octocat" }]));
    vi.stubGlobal("fetch", mockFetch);

    await checkSponsorship("octocat", "DaleStudy", "my-token");

    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.query).toContain("sponsorsActivities");
    expect(body.query).toContain("NEW_SPONSORSHIP");
  });

  it("결제 이벤트의 timestamp를 record의 createdAt으로 사용한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeSponsorshipResponse([{ login: "octocat", createdAt: "2026-06-27T09:00:00Z", amount: 5 }]),
      ),
    );

    const result = await checkSponsorship("octocat", "DaleStudy", "test-token");
    expect(result.records).toEqual([
      { createdAt: "2026-06-27T09:00:00Z", isOneTimePayment: true, amount: 5 },
    ]);
  });

  it("재참여자의 반복 일시후원이 각각 별도 레코드로 집계된다", async () => {
    // 같은 후원자가 지난 기수와 새 기수에 각각 일시후원한 경우,
    // 두 결제가 각자의 timestamp로 별도 기록되어 호출부의 날짜 필터가 정확히 동작한다.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeSponsorshipResponse([
          { login: "u-siop", createdAt: "2026-02-10T00:00:00Z", amount: 5 },
          { login: "u-siop", createdAt: "2026-06-27T09:00:00Z", amount: 5 },
        ]),
      ),
    );

    const result = await checkSponsorship("u-siop", "DaleStudy", "test-token");
    expect(result.sponsored).toBe(true);
    expect(result.records).toHaveLength(2);
    expect(result.records.map((r) => r.createdAt)).toEqual([
      "2026-02-10T00:00:00Z",
      "2026-06-27T09:00:00Z",
    ]);
  });

  it("null 노드가 섞여 있어도 크래시 없이 건너뛴다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            data: {
              organization: {
                sponsorsActivities: {
                  nodes: [
                    null,
                    {
                      timestamp: "2026-06-27T00:00:00Z",
                      sponsorsTier: { monthlyPriceInDollars: 5, isOneTime: true },
                      sponsor: { login: "octocat" },
                    },
                    null,
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          }),
      }),
    );

    const result = await checkSponsorship("octocat", "DaleStudy", "test-token");
    expect(result.sponsored).toBe(true);
    expect(result.records).toHaveLength(1);
  });
});

describe("getTeamCreatedAt", () => {
  it("팀 생성일을 반환한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ created_at: "2024-03-01T00:00:00Z" }),
      }),
    );

    const result = await getTeamCreatedAt("DaleStudy", "members", "test-token");
    expect(result).toBe("2024-03-01T00:00:00Z");
  });

  it("팀 조회 실패 시 예외를 던진다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ message: "Not Found" }),
      }),
    );

    await expect(
      getTeamCreatedAt("DaleStudy", "nonexistent", "test-token"),
    ).rejects.toThrow("Failed to get team info");
  });
});

describe("inviteToTeam", () => {
  it("조직 멤버인 경우 active를 반환한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ state: "active" }),
      }),
    );

    const result = await inviteToTeam("DaleStudy", "members", "octocat", "test-token");
    expect(result).toBe("active");
  });

  it("조직 외부인인 경우 pending을 반환한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ state: "pending" }),
      }),
    );

    const result = await inviteToTeam("DaleStudy", "members", "newuser", "test-token");
    expect(result).toBe("pending");
  });

  it("API 실패 시 예외를 던진다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ message: "Not Found" }),
      }),
    );

    await expect(
      inviteToTeam("DaleStudy", "nonexistent", "octocat", "test-token"),
    ).rejects.toThrow("Failed to invite to team");
  });
});

describe("getInstallationToken", () => {
  it("Installation Token을 반환한다", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ token: "ghs_test_token" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    vi.stubGlobal("crypto", {
      subtle: {
        importKey: vi.fn().mockResolvedValue("mock-key"),
        sign: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      },
    });

    const token = await getInstallationToken(mockEnv);
    expect(token).toBe("ghs_test_token");
  });

  it("토큰 발급 실패 시 예외를 던진다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ message: "Bad credentials" }),
      }),
    );
    vi.stubGlobal("crypto", {
      subtle: {
        importKey: vi.fn().mockResolvedValue("mock-key"),
        sign: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      },
    });

    await expect(getInstallationToken(mockEnv)).rejects.toThrow(
      "Failed to get installation token",
    );
  });
});
