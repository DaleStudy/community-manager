import type { Env } from "./types.js";

/**
 * GitHub App Installation Token 발급
 */
export async function getInstallationToken(env: Env): Promise<string> {
  const jwt = await createJWT(env.APP_ID, env.APP_PRIVATE_KEY);

  const tokenResponse = await fetch(
    `https://api.github.com/app/installations/${env.APP_INSTALLATION_ID}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "DaleStudy-Community-Manager",
      },
    }
  );

  const tokenData = await tokenResponse.json() as any;

  if (!tokenData.token) {
    throw new Error(`Failed to get installation token: ${JSON.stringify(tokenData)}`);
  }

  return tokenData.token;
}

/**
 * GitHub 후원 여부 확인 (GraphQL)
 */
export async function checkSponsorship(
  githubUsername: string,
  org: string,
  token: string
): Promise<boolean> {
  const query = `
    query($login: String!, $org: String!) {
      user(login: $login) {
        isSponsoredBy(accountLogin: $org)
      }
    }
  `;

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "DaleStudy-Community-Manager",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: { login: githubUsername, org } }),
  });

  const result = await response.json() as any;

  if (result.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(result.errors)}`);
  }

  return result.data?.user?.isSponsoredBy === true;
}

/**
 * JWT 생성 (RS256)
 */
async function createJWT(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 10 * 60, iss: appId };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));

  const privateKey = await importPrivateKey(privateKeyPem);
  const signature = await sign(`${encodedHeader}.${encodedPayload}`, privateKey);

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const isPKCS8 = pem.includes("BEGIN PRIVATE KEY");
  const pemHeader = isPKCS8 ? "-----BEGIN PRIVATE KEY-----" : "-----BEGIN RSA PRIVATE KEY-----";
  const pemFooter = isPKCS8 ? "-----END PRIVATE KEY-----" : "-----END RSA PRIVATE KEY-----";

  const pemContents = pem.replace(pemHeader, "").replace(pemFooter, "").replace(/\s/g, "");
  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function sign(data: string, key: CryptoKey): Promise<string> {
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(data)
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
