/**
 * Who a run is, when it calls back.
 *
 * A run asks this instance for its context, its provider key and a GitHub token,
 * from a machine the operator may not own. Two things can vouch for it, and they
 * exist because the three execution modes do not have the same evidence
 * available:
 *
 *   - A GitHub Actions OIDC token. GitHub signs a short-lived assertion naming
 *     the repository and workflow the job belongs to, and the signature is
 *     checked against GitHub's own published keys. Nothing on the runner can
 *     forge it, which is what makes it safe to accept from a machine Polaris does
 *     not control. Used by `actions` and `runners`.
 *   - A run token Polaris minted at dispatch. There is no OIDC when Polaris
 *     starts the container itself, and there does not need to be: the caller is
 *     something this instance started. The raw token is handed over once and only
 *     its hash is stored, so a database dump cannot be replayed.
 *
 * Both resolve to the same answer - which AgentRun this is - and every route that
 * serves a run goes through `authenticateRun`.
 */

import { prisma } from "@polaris/db";
import { hashToken } from "@polaris/core/tokens";
import { isTerminalRunState, type AgentRunState } from "@polaris/core";
import { createPublicKey, createVerify, type JsonWebKey as NodeJsonWebKey } from "node:crypto";

/** Audience the runtime asks GitHub to mint its assertion for. Must match the
 *  value in the vendored runtime, which is what a mismatch here would break. */
const OIDC_AUDIENCE = "polaris-agents";
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = `${OIDC_ISSUER}/.well-known/jwks`;

/** GitHub rotates its signing keys, so the set is re-read rather than pinned.
 *  Cached briefly: every run start would otherwise be a second round trip, and
 *  a key that has just rotated is found by the miss path below. */
let jwksCache: { keys: NodeJsonWebKey[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 10 * 60 * 1000;

interface OidcClaims {
    iss?: string;
    aud?: string | string[];
    exp?: number;
    nbf?: number;
    repository?: string;
    repository_id?: string;
    workflow_ref?: string;
    run_id?: string;
    event_name?: string;
}

async function fetchJwks(force = false): Promise<NodeJsonWebKey[]> {
    const fresh = jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;
    if (fresh && !force) return jwksCache!.keys;
    const response = await fetch(JWKS_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`GitHub returned ${response.status} for its signing keys`);
    const body = (await response.json()) as { keys?: NodeJsonWebKey[] };
    const keys = Array.isArray(body.keys) ? body.keys : [];
    jwksCache = { keys, fetchedAt: Date.now() };
    return keys;
}

function decodeSegment(segment: string): unknown {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

/**
 * Verify a GitHub Actions OIDC token and return what it asserts.
 *
 * Returns null rather than throwing on anything unverifiable: the caller answers
 * 401 either way, and distinguishing "bad signature" from "expired" for an
 * unauthenticated caller only tells an attacker which half to fix.
 */
export async function verifyGithubOidc(token: string): Promise<{ repository: string; runId: string | null } | null> {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

    let header: { alg?: string; kid?: string };
    let claims: OidcClaims;
    try {
        header = decodeSegment(headerPart) as { alg?: string; kid?: string };
        claims = decodeSegment(payloadPart) as OidcClaims;
    } catch {
        return null;
    }

    // Only RS256. Accepting whatever the token names is how `alg: none` and
    // HMAC-with-the-public-key confusions get in.
    if (header.alg !== "RS256" || !header.kid) return null;

    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== OIDC_ISSUER || !audiences.includes(OIDC_AUDIENCE)) return null;

    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp <= now) return null;
    if (typeof claims.nbf === "number" && claims.nbf > now + 60) return null;
    if (typeof claims.repository !== "string" || !claims.repository.includes("/")) return null;

    // A key that is not in the cached set may be one GitHub has just rotated in,
    // so a miss re-reads the set once before giving up.
    let jwk = (await fetchJwks()).find((key) => (key as { kid?: string }).kid === header.kid);
    if (!jwk) jwk = (await fetchJwks(true)).find((key) => (key as { kid?: string }).kid === header.kid);
    if (!jwk) return null;

    let verified = false;
    try {
        const key = createPublicKey({ key: jwk, format: "jwk" });
        verified = createVerify("RSA-SHA256")
            .update(`${headerPart}.${payloadPart}`)
            .verify(key, Buffer.from(signaturePart, "base64url"));
    } catch {
        return null;
    }
    if (!verified) return null;

    return { repository: claims.repository, runId: typeof claims.run_id === "string" ? claims.run_id : null };
}

/** The run a caller turned out to be, with everything a route needs about it. */
export interface AuthenticatedRun {
    runId: string;
    repoId: string;
    repoFullName: string;
    ownerId: string;
    installationId: string;
    state: AgentRunState;
    /**
     * GitHub's own workflow run id, when the caller proved one.
     *
     * Only the OIDC path has it, and it is what correlates a job to its row for
     * the rest of the run's life: the `workflow_run.completed` webhook knows
     * this id and nothing else, so a run that never records it can never be
     * closed out by the webhook.
     */
    githubRunId: string | null;
}

/**
 * Resolve the caller to a run, or null.
 *
 * The OIDC path finds the run rather than trusting one named in the request: a
 * job's assertion proves which repository it is, so the run it may speak for is
 * the one this instance most recently dispatched there. That is what stops a
 * workflow in a repository somebody else enabled from reading a run of ours.
 */
export async function authenticateRun(headers: Headers): Promise<AuthenticatedRun | null> {
    const bearer = headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();

    // The runtime presents its credential two ways depending on the call: the run
    // token on most of them, and the OIDC assertion directly as the bearer when it
    // exchanges one for a GitHub token. A JWT is three dot-separated segments and
    // a run token is base64url with none, so they are told apart by shape rather
    // than by running the wrong verifier and hoping it refuses.
    if (bearer) {
        if (bearer.split(".").length === 3) {
            const asserted = await verifyGithubOidc(bearer);
            if (asserted) return runForRepository(asserted.repository, asserted.runId);
        } else {
            const found = await runByToken(bearer);
            if (found) return found;
        }
    }

    const oidcToken = headers.get("x-github-oidc-token")?.trim();
    if (!oidcToken) return null;
    const asserted = await verifyGithubOidc(oidcToken);
    if (!asserted) return null;
    return runForRepository(asserted.repository, asserted.runId);
}

async function runByToken(token: string): Promise<AuthenticatedRun | null> {
    const row = await prisma.agentRun.findFirst({
        where: { tokenHash: hashToken(token) },
        select: {
            id: true,
            state: true,
            repoId: true,
            repo: { select: { repoFullName: true, ownerId: true, installationId: true } }
        }
    });
    if (!row) return null;
    // A token stops working the moment its run stops. Nothing legitimate calls
    // back after that, and leaving it live would leave a credential lying around
    // for as long as the row exists.
    if (isTerminalRunState(row.state as AgentRunState)) return null;
    return {
        runId: row.id,
        repoId: row.repoId,
        repoFullName: row.repo.repoFullName,
        ownerId: row.repo.ownerId,
        installationId: row.repo.installationId,
        state: row.state as AgentRunState,
        githubRunId: null
    };
}

/**
 * The run an OIDC-authenticated job belongs to.
 *
 * Once a job has recorded GitHub's workflow run id, that id is what identifies
 * it, and every later call matches exactly. The fallback below is only for a
 * job's very first call, when nothing has recorded anything yet: it claims the
 * oldest run on this repository that no job has claimed, so two concurrent jobs
 * take two different rows instead of both taking the newest. Without that, one
 * job reads the other's model and instructions and marks the wrong row started.
 *
 * A workflow started by hand from the Actions tab has no Polaris row to claim,
 * so it gets nothing - and then fails saying this repository is not enabled,
 * rather than being handed a context and the operator's provider keys.
 */
async function runForRepository(repoFullName: string, githubRunId: string | null): Promise<AuthenticatedRun | null> {
    const open = { repo: { repoFullName, enabled: true }, state: { in: ["queued", "running"] } };
    const select = {
        id: true,
        state: true,
        repoId: true,
        repo: { select: { repoFullName: true, ownerId: true, installationId: true } }
    };

    const claimed = githubRunId
        ? await prisma.agentRun.findFirst({ where: { ...open, githubRunId }, select })
        : null;

    const row =
        claimed ??
        (await prisma.agentRun.findFirst({
            where: { ...open, githubRunId: null },
            orderBy: { createdAt: "asc" },
            select
        }));

    if (!row) return null;
    return {
        runId: row.id,
        repoId: row.repoId,
        repoFullName: row.repo.repoFullName,
        ownerId: row.repo.ownerId,
        installationId: row.repo.installationId,
        state: row.state as AgentRunState,
        githubRunId
    };
}
