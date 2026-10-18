import { readFileSync } from "fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const fetchMock = vi.fn();
let devVars = "";

beforeEach(async () => {
  vi.resetModules();
  devVars = "";
  const actual = await vi.importActual<typeof import("fs")>("fs");
  vi.mocked(readFileSync).mockImplementation((...args) => {
    // Never load local credentials during tests; keep the real JSONC configuration.
    if (args[0] === ".dev.vars") {
      if (devVars) return devVars;
      throw Object.assign(new Error("Not found"), { code: "ENOENT" });
    }
    return actual.readFileSync(...args);
  });
  vi.stubEnv("DISCORD_APPLICATION_ID", "test-app");
  vi.stubEnv("DISCORD_TOKEN", "test-token");
  vi.stubEnv("DISCORD_GUILD_ID", undefined);
  vi.stubEnv("ROLE_TEAM_CONFIG", undefined);
  fetchMock.mockReset().mockResolvedValue(Response.json({ id: "test-command" }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("registers only /verify with the deployed guild and current cohort", async () => {
  await import("./register-commands.js");

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, request] = fetchMock.mock.calls[0];
  expect(url).toBe("https://discord.com/api/v10/applications/test-app/guilds/775115965964222492/commands");
  expect(request.method).toBe("PUT");
  const commands = JSON.parse(request.body);
  expect(commands).toHaveLength(1);
  const [command] = commands;
  expect(command.name).toBe("verify");
  for (const name of ["team", "role"]) {
    expect(command.options.find((option: { name: string }) => option.name === name).choices).toEqual(
      ["leetcode09"].map((value) => ({ name: value, value })),
    );
  }
});

it("always uses JSONC guild and choices even when environment or local overrides exist", async () => {
  vi.stubEnv("DISCORD_GUILD_ID", "env-guild");
  vi.stubEnv("ROLE_TEAM_CONFIG", '[{"value":"env-team","label":"Env team"}]');
  devVars = [
    "DISCORD_GUILD_ID=test-guild",
    'ROLE_TEAM_CONFIG=[{"value":"test-team","label":"Test team"}]',
    "DISCORD_TOKEN=local-token",
  ].join("\n");
  await import("./register-commands.js");

  const [url, request] = fetchMock.mock.calls[0];
  expect(url).toContain("/guilds/775115965964222492/commands");
  expect(request.headers.Authorization).toBe("Bot test-token");
  const commands = JSON.parse(request.body);
  expect(commands).toHaveLength(1);
  const [command] = commands;
  for (const name of ["team", "role"]) {
    expect(command.options.find((option: { name: string }) => option.name === name).choices).toEqual(
      ["leetcode09"].map((value) => ({ name: value, value })),
    );
  }
});

it("rejects a Discord HTTP error so the registration step cannot report success", async () => {
  fetchMock.mockResolvedValue(new Response("Missing Access", { status: 403 }));
  await expect(import("./register-commands.js")).rejects.toThrow(
    "Discord command registration failed (403): Missing Access",
  );
});
