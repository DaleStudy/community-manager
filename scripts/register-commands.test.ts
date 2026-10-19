import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readWranglerVars } from "./wrangler-vars.js";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("DISCORD_APPLICATION_ID", "test-app");
  vi.stubEnv("DISCORD_TOKEN", "test-token");
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("sends /verify registration with the configured guild, team and role options", async () => {
  const vars = readWranglerVars();
  const teams = JSON.parse(vars.ROLE_TEAM_CONFIG);
  fetchMock.mockResolvedValue(Response.json({ id: "test-command" }));
  await import("./register-commands.js");

  const [url, request] = fetchMock.mock.calls[0];
  expect(url).toBe(
    `https://discord.com/api/v10/applications/test-app/guilds/${vars.DISCORD_GUILD_ID}/commands`,
  );
  const [command] = JSON.parse(request.body);
  expect(command.name).toBe("verify");
  for (const name of ["team", "role"]) {
    const option = command.options.find((option: { name: string }) => option.name === name);
    expect(option.choices).toHaveLength(teams.length);
    for (const [index, team] of teams.entries()) {
      expect(option.choices[index]).toEqual({ name: team.label, value: team.value });
    }
  }
});

it("rejects a Discord HTTP error so the registration step cannot report success", async () => {
  fetchMock.mockResolvedValue(new Response("Missing Access", { status: 403 }));
  await expect(import("./register-commands.js")).rejects.toThrow(
    "Discord command registration failed (403): Missing Access",
  );
});
