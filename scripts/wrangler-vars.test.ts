import { expect, it } from "vitest";
import { readWranglerVars } from "./wrangler-vars.js";

it("reads vars from the project wrangler.jsonc", () => {
  const vars = readWranglerVars();

  expect(vars).toMatchObject({
    GITHUB_ORG: "DaleStudy",
    DISCORD_GUILD_ID: expect.any(String),
  });
});

it("reads team and role configuration from the project wrangler.jsonc", () => {
  const vars = readWranglerVars();
  const teams = JSON.parse(vars.ROLE_TEAM_CONFIG);

  expect(teams).toBeInstanceOf(Array);
  expect(teams.length).toBe(1);
  for (const team of teams) {
    expect(team).toMatchObject({
      value: expect.any(String),
      label: expect.any(String),
      discordRoleId: expect.any(String),
      teamSlug: expect.any(String),
    });
  }
});

it("reads DaleUI configuration from the project wrangler.jsonc", () => {
  const vars = readWranglerVars();
  const members = JSON.parse(vars.DALEUI_MEMBER_MAP);

  expect(vars).toMatchObject({
    DALEUI_CHANNEL_ID: expect.any(String),
    DALEUI_ROLE_ID: expect.any(String),
    DALEUI_PROJECT_NUMBER: expect.any(String),
  });
  expect(members).toBeInstanceOf(Array);
  expect(members.length).toBeGreaterThan(0);
  for (const member of members) {
    expect(member).toMatchObject({
      discordId: expect.any(String),
      github: expect.any(String),
    });
  }
});
