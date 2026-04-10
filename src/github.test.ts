import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkSponsorship, getInstallationToken } from "./github.js";
import type { Env } from "./types.js";

const mockEnv: Env = {
  DISCORD_PUBLIC_KEY: "test-public-key",
  DISCORD_BOT_TOKEN: "test-bot-token",
  DISCORD_GUILD_ID: "test-guild-id",
  GITHUB_ORG: "DaleStudy",
  APP_ID: "123456",
  APP_INSTALLATION_ID: "789",
  APP_PRIVATE_KEY: "",
  ROLE_TEAM_CONFIG: "[]",
};

function makeSponsorshipResponse(
  logins: string[],
  hasNextPage = false,
  endCursor: string | null = null,
) {
  return {
    json: () =>
      Promise.resolve({
        data: {
          organization: {
            sponsorshipsAsMaintainer: {
              nodes: logins.map((login) => ({
                sponsorEntity: { login },
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
  it("후원 중인 경우 true를 반환한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeSponsorshipResponse(["octocat"])),
    );

    const result = await checkSponsorship("octocat", "DaleStudy", "test-token");
    expect(result).toBe(true);
  });

  it("대소문자 구분 없이 true를 반환한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeSponsorshipResponse(["OctoCAT"])),
    );

    const result = await checkSponsorship("octocat", "DaleStudy", "test-token");
    expect(result).toBe(true);
  });

  it("후원하지 않는 경우 false를 반환한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeSponsorshipResponse(["someone-else"])),
    );

    const result = await checkSponsorship("octocat", "DaleStudy", "test-token");
    expect(result).toBe(false);
  });

  it("페이지네이션으로 다음 페이지에서 찾으면 true를 반환한다", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        makeSponsorshipResponse(["alice", "bob"], true, "cursor1"),
      )
      .mockResolvedValueOnce(makeSponsorshipResponse(["octocat"]));
    vi.stubGlobal("fetch", mockFetch);

    const result = await checkSponsorship("octocat", "DaleStudy", "test-token");
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("모든 페이지 순회 후 없으면 false를 반환한다", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        makeSponsorshipResponse(["alice"], true, "cursor1"),
      )
      .mockResolvedValueOnce(makeSponsorshipResponse(["bob"]));
    vi.stubGlobal("fetch", mockFetch);

    const result = await checkSponsorship("octocat", "DaleStudy", "test-token");
    expect(result).toBe(false);
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
      .mockResolvedValue(makeSponsorshipResponse(["octocat"]));
    vi.stubGlobal("fetch", mockFetch);

    await checkSponsorship("octocat", "DaleStudy", "my-token");

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.github.com/graphql");
    expect(options.headers["Authorization"]).toBe("Bearer my-token");
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
