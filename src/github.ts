import type { Env } from "./types.js";

/**
 * GitHub App Installation Token 발급
 */
export async function getInstallationToken(env: Env): Promise<string> {
  const jwt = await createJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);

  const tokenResponse = await fetch(
    `https://api.github.com/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "DaleStudy-Community-Manager",
      },
    },
  );

  const tokenData = (await tokenResponse.json()) as any;

  if (!tokenData.token) {
    throw new Error(
      `Failed to get installation token: ${JSON.stringify(tokenData)}`,
    );
  }

  return tokenData.token;
}

export interface SponsorshipRecord {
  createdAt: string;
  isOneTimePayment: boolean;
  amount: number;
}

export interface SponsorshipInfo {
  sponsored: boolean;
  records: SponsorshipRecord[];
}

/**
 * GitHub 후원 여부 확인
 *
 * 후원 "관계"가 아니라 결제 "이벤트"(NEW_SPONSORSHIP)를 조회한다. 각 결제의 실제 timestamp 를
 * 쓰므로 반복 일시후원·재참여 후원을 결제일 기준으로 집계할 수 있다.
 * (팀 생성일 이후만 합산하는 날짜 필터는 호출부에서 수행)
 */
export async function checkSponsorship(
  githubUsername: string,
  org: string,
  token: string,
): Promise<SponsorshipInfo> {
  const query = `
    query($org: String!, $cursor: String) {
      organization(login: $org) {
        sponsorsActivities(first: 100, after: $cursor, period: ALL, includePrivate: true, actions: [NEW_SPONSORSHIP]) {
          nodes {
            timestamp
            sponsorsTier { monthlyPriceInDollars isOneTime }
            sponsor {
              ... on User { login }
              ... on Organization { login }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  `;

  let cursor: string | null = null;
  const records: SponsorshipRecord[] = [];

  while (true) {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "DaleStudy-Community-Manager",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: { org, cursor } }),
    });

    const result = (await response.json()) as any;

    if (result.errors) {
      throw new Error(`GraphQL error: ${JSON.stringify(result.errors)}`);
    }

    const activities = result.data?.organization?.sponsorsActivities;
    const nodes = activities?.nodes ?? [];

    for (const node of nodes) {
      if (node?.sponsor?.login?.toLowerCase() !== githubUsername.toLowerCase()) continue;
      records.push({
        createdAt: node.timestamp,
        isOneTimePayment: node.sponsorsTier?.isOneTime ?? false,
        amount: node.sponsorsTier?.monthlyPriceInDollars ?? 0,
      });
    }

    if (!activities?.pageInfo?.hasNextPage) break;
    cursor = activities.pageInfo.endCursor;
  }

  if (records.length === 0) {
    return { sponsored: false, records: [] };
  }

  return { sponsored: true, records };
}

/**
 * GitHub 팀 생성일 조회
 */
export async function getTeamCreatedAt(
  org: string,
  teamSlug: string,
  token: string,
): Promise<string> {
  const response = await fetch(
    `https://api.github.com/orgs/${org}/teams/${teamSlug}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "DaleStudy-Community-Manager",
      },
    },
  );

  const data = (await response.json()) as any;

  if (!data.created_at) {
    throw new Error(`Failed to get team info: ${JSON.stringify(data)}`);
  }

  return data.created_at;
}

/**
 * GitHub 팀 멤버십 상태 조회
 */
export async function getTeamMembership(
  org: string,
  teamSlug: string,
  username: string,
  token: string,
): Promise<"active" | "pending" | null> {
  const response = await fetch(
    `https://api.github.com/orgs/${org}/teams/${teamSlug}/memberships/${username}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "DaleStudy-Community-Manager",
      },
    },
  );

  if (response.status === 404) return null;

  const data = (await response.json()) as any;
  return data.state ?? null;
}

/**
 * GitHub 팀 멤버 추가 또는 초대
 */
export async function inviteToTeam(
  org: string,
  teamSlug: string,
  username: string,
  token: string,
): Promise<"active" | "pending"> {
  const response = await fetch(
    `https://api.github.com/orgs/${org}/teams/${teamSlug}/memberships/${username}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "DaleStudy-Community-Manager",
      },
    },
  );

  const data = (await response.json()) as any;

  if (!response.ok) {
    throw new Error(`Failed to invite to team: ${JSON.stringify(data)}`);
  }

  return data.state;
}

/**
 * JWT 생성 (RS256)
 */
async function createJWT(
  appId: string,
  privateKeyPem: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 10 * 60, iss: appId };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));

  const privateKey = await importPrivateKey(privateKeyPem);
  const signature = await sign(
    `${encodedHeader}.${encodedPayload}`,
    privateKey,
  );

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const isPKCS8 = pem.includes("BEGIN PRIVATE KEY");
  const pemHeader = isPKCS8
    ? "-----BEGIN PRIVATE KEY-----"
    : "-----BEGIN RSA PRIVATE KEY-----";
  const pemFooter = isPKCS8
    ? "-----END PRIVATE KEY-----"
    : "-----END RSA PRIVATE KEY-----";

  const pemContents = pem
    .replace(pemHeader, "")
    .replace(pemFooter, "")
    .replace(/\s/g, "");
  const pkcs1Der = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  // GitHub App 키는 PKCS1 형식이므로 PKCS8로 변환
  const keyData = isPKCS8 ? pkcs1Der : pkcs1ToPkcs8(pkcs1Der);

  return crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  function encodeLength(len: number): Uint8Array {
    if (len < 128) return new Uint8Array([len]);
    if (len < 256) return new Uint8Array([0x81, len]);
    return new Uint8Array([0x82, (len >> 8) & 0xff, len & 0xff]);
  }

  function concat(...arrays: Uint8Array[]): Uint8Array {
    const total = arrays.reduce((sum, a) => sum + a.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) {
      result.set(a, offset);
      offset += a.length;
    }
    return result;
  }

  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaOid = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00,
  ]);
  const octetString = concat(
    new Uint8Array([0x04]),
    encodeLength(pkcs1.length),
    pkcs1,
  );
  const inner = concat(version, rsaOid, octetString);
  return concat(new Uint8Array([0x30]), encodeLength(inner.length), inner);
}

async function sign(data: string, key: CryptoKey): Promise<string> {
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(data),
  );
  return base64UrlEncode(new Uint8Array(signature));
}

function base64UrlEncode(data: string | Uint8Array): string {
  if (typeof data === "string") {
    data = new TextEncoder().encode(data);
  }
  let binary = "";
  for (let i = 0; i < data.byteLength; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
