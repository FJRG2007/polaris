/**
 * The extension's own connection to a Polaris account.
 *
 * This is the first thing the extension does and the thing everything else hangs
 * off. It used to start at the vault - the first screen asked to be let into
 * one, and the only credential this browser held was a vault credential - which
 * made "connected to Polaris" mean "signed in to a password vault". The
 * extension is the product's window in the toolbar rather than one feature of
 * it, so what it asks for first is a connection to the account, and a vault is
 * one thing that connection may then be used for.
 *
 * The shape is the device-authorization one, which is what a television asking
 * to be signed in to a streaming service does: this browser asks, shows a short
 * code, and somebody approves it in a Polaris they are already signed in to.
 * Nothing here is typed into the popup and no password ever is.
 *
 * What comes back is one bearer token. Polaris stores only its hash, lists the
 * connection on the account's Sessions screen, and can end it there - so
 * `check()` below is not a nicety: it is how a browser somebody disconnected
 * finds out, and the answer that says so is a plain 401.
 *
 * Background worker only. Nothing on a page may hold this token.
 */

/** How long a call may hang before it is somebody's problem rather than a wait. */
const TIMEOUT_MS = 20_000;

/** What to wait between polls when the server did not say. */
export const DEFAULT_POLL_MS = 2000;

const POLL_MIN_MS = 1000;
const POLL_MAX_MS = 30_000;

/** A request waiting for somebody to approve it in Polaris. */
export interface LinkOpened {
    readonly userCode: string;
    /** This browser's own secret, sent on every poll. Never shown to anybody. */
    readonly deviceCode: string;
    readonly expiresAt: string;
    readonly pollMs: number;
    /** Where somebody goes to approve it, as the server named it. */
    readonly approveUrl: string;
}

/** Who this extension is connected as. */
export interface LinkedAccount {
    readonly id: string;
    readonly name: string;
    readonly email: string;
}

/** Where a request stands, and what it carried if it was approved. */
export type LinkClaim =
    | { readonly status: "pending" | "denied" | "expired" }
    | { readonly status: "approved"; readonly token: string; readonly account: LinkedAccount };

/** One organization the account belongs to, as the dashboard's switcher offers
 *  it, with the vault it holds when it has one. */
export interface LinkOrganization {
    readonly id: string;
    readonly name: string;
    readonly vaultId: string | null;
}

/** What the connection reaches, as the server answers it. */
export interface LinkState {
    readonly account: LinkedAccount;
    readonly connectionName: string;
    /** Whether this account may use a vault at all, so the popup offers one only
     *  where there is one to offer. */
    readonly vault: boolean;
    /** Empty from a server too old to list them, which is also an account that
     *  belongs to none. */
    readonly organizations: readonly LinkOrganization[];
}

function url(origin: string, path: string): string {
    return `${origin}/api/extension/${path}`;
}

/** A fetch that cannot hang forever, and that never throws at its caller. */
async function ask(address: string, init: RequestInit): Promise<Response | null> {
    try {
        return await fetch(address, {
            ...init,
            signal: AbortSignal.timeout(TIMEOUT_MS),
            credentials: "omit"
        });
    } catch {
        return null;
    }
}

/** A period this client will actually wait, whatever the server said. */
function readPollMs(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_POLL_MS;
    return Math.min(Math.max(value, POLL_MIN_MS), POLL_MAX_MS);
}

function readAccount(value: unknown): LinkedAccount | null {
    if (typeof value !== "object" || value === null) return null;
    const row = value as Record<string, unknown>;
    if (typeof row["id"] !== "string" || typeof row["email"] !== "string") return null;
    return {
        id: row["id"],
        name: typeof row["name"] === "string" ? row["name"] : "",
        email: row["email"]
    };
}

/** The organizations in an answer, keeping only rows that are whole. */
export function readOrganizations(value: unknown): LinkOrganization[] {
    if (!Array.isArray(value)) return [];
    const found: LinkOrganization[] = [];
    for (const entry of value) {
        if (typeof entry !== "object" || entry === null) continue;
        const row = entry as Record<string, unknown>;
        if (typeof row["id"] !== "string" || typeof row["name"] !== "string") continue;
        found.push({
            id: row["id"],
            name: row["name"],
            vaultId: typeof row["vaultId"] === "string" ? row["vaultId"] : null
        });
    }
    return found;
}

/** Bytes as base64, in slices so a large picture does not overflow the stack. */
function base64(bytes: Uint8Array): string {
    let text = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
        text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(text);
}

/** The largest picture kept. A face is drawn at 28 pixels; anything bigger than
 *  this is somebody's original upload and not worth holding in storage. */
const MAX_FACE_BYTES = 256 * 1024;

/**
 * The account's own face, or an organization's, as something an <img> can show.
 *
 * A data address rather than the server's URL because the popup has no session
 * to fetch it with - the worker asks with the connection's token, and hands the
 * popup the picture itself. Null is "there is none", which draws initials;
 * undefined is "could not find out", which keeps whatever was held.
 */
export async function fetchFace(
    origin: string,
    token: string,
    orgId: string | null
): Promise<string | null | undefined> {
    const query = orgId ? `?org=${encodeURIComponent(orgId)}` : "";
    const reply = await ask(url(origin, `avatar${query}`), {
        method: "GET",
        headers: { authorization: `Bearer ${token}` }
    });
    if (!reply) return undefined;
    if (reply.status === 204) return null;
    if (!reply.ok) return undefined;
    const type = reply.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) return null;
    const bytes = new Uint8Array(await reply.arrayBuffer().catch(() => new ArrayBuffer(0)));
    if (bytes.length === 0 || bytes.length > MAX_FACE_BYTES) return null;
    return `data:${type.split(";")[0]};base64,${base64(bytes)}`;
}

/**
 * Open a request to be connected.
 *
 * Null for anything that is not an answer: an address that is not a Polaris, a
 * server too old to know this route, a network that is not there. The popup says
 * so rather than showing a code nobody can approve.
 */
export async function openLink(
    origin: string,
    device: { readonly id: string; readonly name: string }
): Promise<LinkOpened | null> {
    const reply = await ask(url(origin, "authorize"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: device.id, deviceName: device.name })
    });
    if (!reply?.ok) return null;
    const body = (await reply.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return null;
    const userCode = body["userCode"];
    const deviceCode = body["deviceCode"];
    if (typeof userCode !== "string" || typeof deviceCode !== "string") return null;
    return {
        userCode,
        deviceCode,
        expiresAt: typeof body["expiresAt"] === "string" ? body["expiresAt"] : "",
        pollMs: readPollMs(body["pollMs"]),
        approveUrl:
            typeof body["approveUrl"] === "string"
                ? body["approveUrl"]
                : `/account/extension?code=${userCode}`
    };
}

/**
 * Ask whether it has been approved, and collect the token when it has.
 *
 * Nothing at all means keep waiting, and that covers every answer that is not
 * the server's own verdict - an unreachable server, a proxy's 502, the 429 this
 * endpoint answers a spent polling budget with. A request that is still alive
 * server-side must not be ended by the road to it.
 */
export async function claimLink(origin: string, deviceCode: string): Promise<LinkClaim | null> {
    const reply = await ask(url(origin, "authorize/claim"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode })
    });
    if (!reply) return null;
    if (reply.status === 429 || reply.status >= 500) return null;
    const body = (await reply.json().catch(() => null)) as Record<string, unknown> | null;
    if (!reply.ok || !body) return { status: "expired" };

    const status = body["status"];
    if (status !== "approved") {
        return {
            status: status === "denied" ? "denied" : status === "pending" ? "pending" : "expired"
        };
    }
    const token = body["token"];
    const account = readAccount(body["account"]);
    // Approved, and unusable. Reported as expired rather than kept: a connection
    // with no token is one every later call would fail on, silently.
    if (typeof token !== "string" || !account) return { status: "expired" };
    return { status: "approved", token, account };
}

/**
 * What the server says about this connection.
 *
 * Three answers, and the difference between them is the whole point: the state
 * when it is live, `"ended"` when Polaris no longer knows this token - which is
 * what somebody pressing Disconnect on their Sessions screen looks like from
 * here - and null when the server could not be reached at all, which is not a
 * reason to throw anything away.
 */
export async function checkLink(
    origin: string,
    token: string
): Promise<LinkState | "ended" | null> {
    const reply = await ask(url(origin, "session"), {
        method: "GET",
        headers: { authorization: `Bearer ${token}` }
    });
    if (!reply) return null;
    if (reply.status === 401 || reply.status === 403) return "ended";
    if (!reply.ok) return null;
    const body = (await reply.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return null;
    const account = readAccount(body["account"]);
    if (!account) return null;
    const connection = body["connection"] as Record<string, unknown> | undefined;
    const can = body["can"] as Record<string, unknown> | undefined;
    return {
        account,
        connectionName: typeof connection?.["name"] === "string" ? connection["name"] : "",
        vault: can?.["vault"] === true,
        organizations: readOrganizations(body["organizations"])
    };
}

/** End this connection from this side. Best effort: what makes it real is the
 *  extension forgetting the token, which the caller does either way. */
export async function endLink(origin: string, token: string): Promise<void> {
    await ask(url(origin, "session"), {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` }
    });
}
