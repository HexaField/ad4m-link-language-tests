/**
 * Async backend provisioning for C1 convergence languages.
 *
 * A few backends cannot be addressed from the neighbourhood id alone: unlike
 * nostr (shared keypair) or solid (deterministic container path), Matrix needs a
 * registered user + room + access token, and AT Proto needs a created account
 * (DID + app password) before a language bundle can be templated against them.
 *
 * These helpers run ONCE per C1 run — after the backend health check and before
 * templating — and return the extra template variables the language needs. Both
 * C1 agents install the SAME templated bundle, so one provisioned identity (one
 * Matrix user + room, one AT Proto account) is shared by both agents, exactly
 * like the shared nostr keypair. Convergence still rides the backend's native
 * merge (Matrix state-resolution, AT Proto MST + cross-repo OR-Set).
 *
 * A provisioning failure is surfaced to the scenario as an honest skip with the
 * reason — never faked into a pass.
 */

/** Matrix homeserver base URL + server-name (must match docker-compose.matrix.yml). */
const MATRIX_BASE = process.env.MATRIX_HOMESERVER_URL || "http://127.0.0.1:6167";

/** AT Proto PDS base URL (must match docker-compose.atproto.yml). */
const ATPROTO_PDS_BASE = process.env.ATPROTO_PDS_URL || "http://127.0.0.1:2583";

/** Fetch JSON, throwing a descriptive error (status + body) on a non-2xx. */
async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // non-JSON body — keep the raw text for the error path
  }
  if (!res.ok) {
    const detail = parsed ? JSON.stringify(parsed) : text.slice(0, 400);
    const err: any = new Error(`POST ${url} → ${res.status}: ${detail}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

/**
 * A short, backend-safe identifier derived from the neighbourhood id. Matrix
 * localparts and AT Proto handles allow only a restricted charset, so strip the
 * `c1-` prefix's dashes and lowercase.
 */
function safeLocalpart(neighbourhoodId: string): string {
  return neighbourhoodId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 24);
}

/**
 * Provision a Matrix user + room on the Conduit homeserver.
 *
 * Registration follows the Matrix User-Interactive Auth flow: the first POST
 * returns 401 with a `session` and the available `flows`; we complete the
 * `m.login.dummy` stage (open registration, no token) with a second POST. Both
 * agents share the returned user + access token + room.
 */
export async function provisionMatrix(
  neighbourhoodId: string,
): Promise<Record<string, string>> {
  const username = `ad4m_${safeLocalpart(neighbourhoodId)}`;
  const password = `pw-${neighbourhoodId}`;
  const registerUrl = `${MATRIX_BASE}/_matrix/client/v3/register`;

  // Step 1: attempt registration without auth to obtain the UIA session.
  let reg: any;
  try {
    reg = await postJson(registerUrl, {
      username,
      password,
      inhibit_login: false,
    });
  } catch (err: any) {
    // The Matrix spec mandates a 401 with a UIA session on the first call.
    if (err.status === 401 && err.body?.session) {
      const flows: Array<{ stages: string[] }> = err.body.flows || [];
      const dummy = flows.some((f) => f.stages?.includes("m.login.dummy"));
      if (!dummy) {
        throw new Error(
          `matrix registration requires a non-dummy auth flow (${JSON.stringify(
            flows,
          )}) — open registration is not available`,
        );
      }
      // Step 2: complete the dummy stage with the session token.
      reg = await postJson(registerUrl, {
        username,
        password,
        inhibit_login: false,
        auth: { type: "m.login.dummy", session: err.body.session },
      });
    } else {
      throw err;
    }
  }

  const accessToken: string | undefined = reg?.access_token;
  const userId: string | undefined = reg?.user_id;
  if (!accessToken || !userId) {
    throw new Error(
      `matrix registration returned no access_token/user_id: ${JSON.stringify(reg)}`,
    );
  }

  // Create a fresh room for this neighbourhood; both agents join it.
  const room = await postJson(
    `${MATRIX_BASE}/_matrix/client/v3/createRoom`,
    { name: `ad4m-c1-${neighbourhoodId}`, preset: "public_chat", visibility: "private" },
    { authorization: `Bearer ${accessToken}` },
  );
  const roomId: string | undefined = room?.room_id;
  if (!roomId) {
    throw new Error(`matrix createRoom returned no room_id: ${JSON.stringify(room)}`);
  }

  return {
    MATRIX_HOMESERVER_URL: MATRIX_BASE,
    MATRIX_USER_ID: userId,
    MATRIX_ACCESS_TOKEN: accessToken,
    MATRIX_ROOM_ID: roomId,
    MATRIX_ROOM_ALIAS: "",
  };
}

/**
 * Provision an AT Proto account on the PDS.
 *
 * `com.atproto.server.createAccount` mints a did:plc and returns the DID + a
 * session JWT. The language re-authenticates with handle + app password, so we
 * return the same password as the app password. Both agents share the single
 * repo; convergence rides that repo's MST commit chain (the cross-repo OR-Set
 * union collapses to a single repo in the co-located C1 model).
 */
export async function provisionAtproto(
  neighbourhoodId: string,
): Promise<Record<string, string>> {
  const local = safeLocalpart(neighbourhoodId);
  // With PDS_HOSTNAME=localhost and no PDS_SERVICE_HANDLE_DOMAINS, the PDS is
  // authoritative for `*.test` handles (its config.js defaults serviceHandleDomains
  // to ['.test'] for a localhost host). `.test` is also atproto's sanctioned
  // dev/testing TLD — `.localhost` is on the disallowed-TLD list in @atproto/syntax.
  //
  // The PDS additionally caps the handle's *front* label (the part before the
  // service domain) at 3–18 chars (ensureHandleServiceConstraints). `ad4m` + 14
  // chars of the neighbourhood-derived localpart = 18 (the max), leaving ample
  // entropy to keep per-run handles distinct.
  const handleFront = `ad4m${local.slice(0, 14)}`;
  const handle = `${handleFront}.test`;
  const password = `pw-${neighbourhoodId}`;
  const email = `${handleFront}@test.local`;

  const acct = await postJson(`${ATPROTO_PDS_BASE}/xrpc/com.atproto.server.createAccount`, {
    handle,
    email,
    password,
  });
  const did: string | undefined = acct?.did;
  if (!did) {
    throw new Error(`atproto createAccount returned no did: ${JSON.stringify(acct)}`);
  }

  return {
    AT_PDS_URL: ATPROTO_PDS_BASE,
    AT_DID: did,
    AT_HANDLE: acct?.handle || handle,
    AT_APP_PASSWORD: password,
    // AT_COLLECTION_NSID and AT_RELAY_URL are left to the language defaults
    // (ad4m.link.triple; no relay needed for a single co-located repo).
  };
}
