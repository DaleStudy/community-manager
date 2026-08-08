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

// ── 달레UI 주간 업데이트 수집 헬퍼 ────────────────────────────────
// 활동 "흔적"을 모으는 읽기 전용 조회들. 요약은 하지 않고 원자료만 만든다.

const GH_API = "https://api.github.com";

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "DaleStudy-Community-Manager",
  };
}

async function ghJson<T>(url: URL, token: string, what: string): Promise<T> {
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) {
    throw new Error(`${what} 실패 (status=${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as T;
}

/** 100건씩 페이지를 넘기며 배열 응답을 모두 모은다. */
async function ghPaged<T>(
  path: string,
  params: Record<string, string>,
  token: string,
  what: string,
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const url = new URL(`${GH_API}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));

    const batch = await ghJson<T[]>(url, token, what);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

export interface ActivityItem {
  repo: string;
  number: number;
  title: string;
  url: string;
  /** open | closed */
  state: string;
  author: string;
  assignees: string[];
  labels: string[];
  createdAt: string;
  updatedAt: string;
  /** PR이면 true */
  isPullRequest: boolean;
  /** PR이 병합된 시각 (병합 전이면 null) */
  mergedAt: string | null;
}

/**
 * 지정 시각 이후 갱신된 이슈와 PR을 모은다.
 *
 * `/issues?since=` 는 이슈와 PR을 함께 돌려주므로 한 번의 조회로 둘 다 얻는다.
 * PR 여부와 병합 시각은 응답의 `pull_request` 필드에서 읽는다.
 */
export async function listRecentIssuesAndPulls(
  org: string,
  repo: string,
  sinceIso: string,
  token: string,
): Promise<ActivityItem[]> {
  const raw = await ghPaged<any>(
    `/repos/${org}/${repo}/issues`,
    { state: "all", sort: "updated", direction: "desc", since: sinceIso },
    token,
    `${repo} 이슈/PR 조회`,
  );

  return raw.map((it) => ({
    repo,
    number: it.number,
    title: it.title,
    url: it.html_url,
    state: it.state,
    author: it.user?.login ?? "unknown",
    assignees: (it.assignees ?? []).map((a: any) => a.login),
    labels: (it.labels ?? []).map((l: any) => l.name ?? l),
    createdAt: it.created_at,
    updatedAt: it.updated_at,
    isPullRequest: Boolean(it.pull_request),
    mergedAt: it.pull_request?.merged_at ?? null,
  }));
}

export interface CommentItem {
  repo: string;
  /** 코멘트가 달린 이슈/PR 번호 */
  number: number;
  author: string;
  body: string;
  url: string;
  createdAt: string;
  /** PR 리뷰 코멘트면 true (일반 이슈 코멘트는 false) */
  isReviewComment: boolean;
}

/**
 * 지정 시각 이후 작성된 코멘트를 모은다. 이슈 코멘트와 PR 리뷰 코멘트를 모두 본다.
 * 자가 보고에 안 잡히는 설계 제안·기술 피드백이 주로 여기서 나온다.
 */
export async function listRecentComments(
  org: string,
  repo: string,
  sinceIso: string,
  token: string,
): Promise<CommentItem[]> {
  // 웹 URL(html_url)은 PR을 /pull/123 단수형으로 쓰므로 번호를 못 읽는다.
  // 이슈 코멘트는 issue_url, 리뷰 코멘트는 pull_request_url을 항상 들고 온다.
  const numberFromComment = (c: any): number =>
    Number(
      (c.issue_url ?? c.pull_request_url ?? "").match(/\/(?:issues|pulls)\/(\d+)/)?.[1] ?? 0,
    );

  const [issueComments, reviewComments] = await Promise.all([
    ghPaged<any>(
      `/repos/${org}/${repo}/issues/comments`,
      { since: sinceIso, sort: "created", direction: "desc" },
      token,
      `${repo} 이슈 코멘트 조회`,
    ),
    ghPaged<any>(
      `/repos/${org}/${repo}/pulls/comments`,
      { since: sinceIso, sort: "created", direction: "desc" },
      token,
      `${repo} 리뷰 코멘트 조회`,
    ),
  ]);

  const toItem = (c: any, isReviewComment: boolean): CommentItem => ({
    repo,
    number: numberFromComment(c),
    author: c.user?.login ?? "unknown",
    body: c.body ?? "",
    url: c.html_url,
    createdAt: c.created_at,
    isReviewComment,
  });

  return [
    ...issueComments.map((c) => toItem(c, false)),
    ...reviewComments.map((c) => toItem(c, true)),
  ];
}

/**
 * 제목에 "Sprint"가 들어간 가장 최근 회의 이슈. 업데이트 스레드 제목으로 그대로 쓴다.
 * github-actions 봇이 스프린트마다 생성하므로 최신 것이 이번 회의다.
 */
export async function getLatestMeetingIssue(
  org: string,
  repo: string,
  token: string,
): Promise<{ number: number; title: string; url: string } | null> {
  const url = new URL(`${GH_API}/search/issues`);
  url.searchParams.set("q", `repo:${org}/${repo} is:issue in:title Sprint`);
  url.searchParams.set("sort", "created");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", "1");

  const data = await ghJson<any>(url, token, "회의 이슈 조회");
  const hit = data.items?.[0];
  return hit
    ? { number: hit.number, title: hit.title, url: hit.html_url }
    : null;
}

export interface BoardItem {
  title: string;
  url: string;
  number: number | null;
  repo: string | null;
  assignees: string[];
  /** Todo / In Progress / Done 등 */
  status: string | null;
  /** 스프린트(iteration) 이름 */
  sprint: string | null;
  priority: string | null;
  estimate: number | null;
}

/**
 * 프로젝트 보드(projectV2) 아이템을 필드 값과 함께 조회한다.
 *
 * 활동 흔적만으로는 안 보이는 것 — 커밋된 범위 대비 소진, 미착수로 남은 고우선순위
 * 항목, In Progress로 정체된 큰 항목 — 이 여기서 드러난다.
 */
export async function getProjectItems(
  org: string,
  projectNumber: number,
  token: string,
): Promise<BoardItem[]> {
  const query = `
    query($org: String!, $number: Int!, $cursor: String) {
      organization(login: $org) {
        projectV2(number: $number) {
          items(first: 100, after: $cursor) {
            nodes {
              content {
                __typename
                ... on Issue {
                  number title url repository { name }
                  assignees(first: 10) { nodes { login } }
                }
                ... on PullRequest {
                  number title url repository { name }
                  assignees(first: 10) { nodes { login } }
                }
                ... on DraftIssue { title }
              }
              fieldValues(first: 20) {
                nodes {
                  __typename
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name field { ... on ProjectV2FieldCommon { name } }
                  }
                  ... on ProjectV2ItemFieldNumberValue {
                    number field { ... on ProjectV2FieldCommon { name } }
                  }
                  ... on ProjectV2ItemFieldIterationValue {
                    title field { ... on ProjectV2FieldCommon { name } }
                  }
                }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  `;

  const items: BoardItem[] = [];
  let cursor: string | null = null;

  while (true) {
    const response = await fetch(`${GH_API}/graphql`, {
      method: "POST",
      headers: { ...ghHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        variables: { org, number: projectNumber, cursor },
      }),
    });

    const result = (await response.json()) as any;
    if (result.errors) {
      throw new Error(`프로젝트 보드 조회 실패: ${JSON.stringify(result.errors)}`);
    }

    const page = result.data?.organization?.projectV2?.items;
    for (const node of page?.nodes ?? []) {
      const content = node.content ?? {};

      // 필드 이름의 앞부분으로 찾는다. 값 노드 중에는 field 가 없는 종류도 섞여 있다.
      const fieldValue = (needle: string) =>
        (node.fieldValues?.nodes ?? []).find((v: any) =>
          v?.field?.name?.toLowerCase().startsWith(needle),
        );

      items.push({
        title: content.title ?? "(제목 없음)",
        url: content.url ?? "",
        number: content.number ?? null,
        repo: content.repository?.name ?? null,
        assignees: (content.assignees?.nodes ?? []).map((a: any) => a.login),
        status: fieldValue("status")?.name ?? null,
        sprint: fieldValue("sprint")?.title ?? null,
        priority: fieldValue("priority")?.name ?? null,
        // 보드의 실제 필드 이름은 "Est" 다. "Estimate" 로 바뀌어도 접두사 매칭으로 잡힌다.
        estimate: fieldValue("est")?.number ?? null,
      });
    }

    if (!page?.pageInfo?.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  return items;
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
