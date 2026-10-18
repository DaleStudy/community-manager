import { readFileSync } from "fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("fs", () => ({ readFileSync: vi.fn() }));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.mocked(readFileSync).mockReturnValue(String.raw`{
    "vars": {
      "DISCORD_GUILD_ID": "test-guild",
      "ROLE_TEAM_CONFIG": "[{\"value\":\"test-team\",\"label\":\"Test Team\"}]",
    },
  }`);
  vi.stubEnv("DISCORD_APPLICATION_ID", "test-app");
  vi.stubEnv("DISCORD_TOKEN", "test-token");
  fetchMock.mockReset().mockResolvedValue(Response.json({ id: "test-command" }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("sends /verify registration with the guild, team and role options from JSONC", async () => {
  await import("./register-commands.js");

  const [url, request] = fetchMock.mock.calls[0];
  expect(url).toBe("https://discord.com/api/v10/applications/test-app/guilds/test-guild/commands");
  const [command] = JSON.parse(request.body);
  expect(command.name).toBe("verify");
  for (const name of ["team", "role"]) {
    expect(command.options.find((option: { name: string }) => option.name === name).choices).toEqual([
      { name: "Test Team", value: "test-team" },
    ]);
  }
});

it("rejects a Discord HTTP error so the registration step cannot report success", async () => {
  fetchMock.mockResolvedValue(new Response("Missing Access", { status: 403 }));
  await expect(import("./register-commands.js")).rejects.toThrow(
    "Discord command registration failed (403): Missing Access",
  );
});
