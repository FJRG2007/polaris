/**
 * Signing in the command-line client (`plr login`), from asking to signing out.
 *
 * **The shape is the device-authorization grant** (RFC 8628), the same one the
 * browser extension's connection uses and the one Railway's and GitHub's CLIs
 * use: the CLI opens a request, shows a short code and opens the browser on the
 * approval screen, and somebody already signed in to Polaris says yes there.
 * Nothing the CLI holds is worth anything until then.
 *
 * **What it is handed is an ordinary API key of kind "cli".** Not a new kind of
 * credential: an API key is already scoped, narrowed to what its owner holds at
 * every call, bound by the account's network rules, counted, listed on the API
 * keys screen and revocable there. A second token type would need every one of
 * those again. The kind only labels the row and lets the CLI end its own sign-in.
 *
 * **The token is minted when it is collected**, not when it is approved, so
 * nothing anywhere holds a usable credential for a request nobody came back for;
 * and the row is spent by that collection, so it is handed over exactly once.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { generateToken, hashToken } from "@polaris/core/tokens";
import { CLI_TOKEN_DAYS, isCliScope, type CliScope } from "./scopes";
import { createApiKey, revokeApiKey, scopesAvailableTo } from "@polaris/auth";
import { AUTHORIZATION_POLL_MS, AUTHORIZATION_TTL_MS, newUserCode } from "@/lib/device-code";
import { createApiKeySchema, describeClient, parseStringList, stringifyList } from "@polaris/core";

/** What the CLI is handed when it asks. */
export interface OpenedCliSignIn {
    readonly userCode: string;
    /** The CLI's own secret, sent back on every poll. Never stored as-is. */
    readonly deviceCode: string;
    readonly expiresAt: Date;
    readonly pollMs: number;
}

/** What a CLI says about itself, and what the request looked like. The second
 *  half is read off the request, never out of its body. */
export interface CliSignInRequest {
    readonly deviceName: string;
    readonly clientVersion: string | null;
    readonly scopes: readonly CliScope[];
    readonly requestIp: string | null;
    readonly requestUserAgent: string | null;
    readonly requestHost: string | null;
}

/** A waiting request, as the person deciding on it is shown it. */
export interface PendingCliSignIn {
    readonly userCode: string;
    /** What the CLI called itself - its machine's name. A label, never a decision. */
    readonly device: string;
    readonly clientVersion: string | null;
    /** The system its user-agent names, or "Unknown OS". */
    readonly os: string;
    readonly scopes: readonly CliScope[];
    readonly requestIp: string | null;
    readonly host: string | null;
    readonly requestedAt: string;
    readonly expiresAt: string;
}

/** Where a request stands, and the credential once it has been approved. */
export type ClaimedCliSignIn =
    | { readonly status: "pending" | "denied" | "expired" }
    | {
          readonly status: "approved";
          /** Handed over exactly once: the row is spent by the time this returns. */
          readonly token: string;
          readonly keyId: string;
          readonly scopes: readonly string[];
          readonly account: { readonly id: string; readonly name: string; readonly email: string };
      };

/** Whether a thrown Prisma error is a unique-constraint violation (P2002) - here,
 *  a short code another opener wrote first. */
function isUniqueViolation(caught: unknown): boolean {
    return (
        typeof caught === "object" &&
        caught !== null &&
        (caught as { code?: string }).code === "P2002"
    );
}

/** The scopes a stored request asked for, with anything that is not a CLI scope
 *  dropped - the column is written only by `openCliSignIn`, but it is read back
 *  as data. */
function storedScopes(raw: string): CliScope[] {
    return parseStringList(raw).filter(isCliScope);
}

/**
 * The OS a CLI's user-agent names. The CLI sends
 * `polaris-cli/<version> (<platform>; <arch>; node <version>)`, which no browser
 * parser recognises, so it is read here; anything else goes to the shared parser.
 */
export function cliOs(userAgent: string | null): string {
    const platform = /^polaris-cli\/\S+ \((win32|darwin|linux|freebsd|openbsd)\b/.exec(
        userAgent ?? ""
    )?.[1];
    if (platform === "win32") return "Windows";
    if (platform === "darwin") return "macOS";
    if (platform === "linux") return "Linux";
    if (platform) return "BSD";
    return describeClient(userAgent).os;
}

/**
 * Open a request.
 *
 * Unauthenticated by nature, so the caller rate-limits it. Null when every code
 * it drew was taken, which is a refusal the caller passes on.
 */
export async function openCliSignIn(
    input: CliSignInRequest,
    random: (size: number) => Uint8Array,
    now = new Date()
): Promise<OpenedCliSignIn | null> {
    // Requests nobody came back for are dead weight the moment they expire.
    await prisma.cliAuthorization.deleteMany({ where: { expiresAt: { lt: now } } });

    const expiresAt = new Date(now.getTime() + AUTHORIZATION_TTL_MS);
    const deviceCode = `${generateToken()}${generateToken()}`;

    for (let attempt = 0; attempt < 5; attempt += 1) {
        const userCode = newUserCode(random);
        try {
            await prisma.cliAuthorization.create({
                data: {
                    codeHash: hashToken(deviceCode),
                    userCode,
                    status: "pending",
                    deviceName: input.deviceName,
                    clientVersion: input.clientVersion,
                    scopes: stringifyList([...input.scopes]),
                    requestIp: input.requestIp,
                    requestUserAgent: input.requestUserAgent,
                    requestHost: input.requestHost,
                    expiresAt
                }
            });
            return { userCode, deviceCode, expiresAt, pollMs: AUTHORIZATION_POLL_MS };
        } catch (caught) {
            if (!isUniqueViolation(caught)) throw caught;
        }
    }
    return null;
}

/** The request behind a code, or null for anything that cannot be answered -
 *  unknown, expired and already answered are one answer, because the code is
 *  short enough to guess at. */
export async function describeCliSignIn(
    userCode: string,
    now = new Date()
): Promise<PendingCliSignIn | null> {
    const row = await prisma.cliAuthorization.findUnique({ where: { userCode } });
    if (!row || row.status !== "pending" || row.expiresAt <= now) return null;
    return {
        userCode: row.userCode,
        device: row.deviceName,
        clientVersion: row.clientVersion,
        os: cliOs(row.requestUserAgent),
        scopes: storedScopes(row.scopes),
        requestIp: row.requestIp,
        host: row.requestHost,
        requestedAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString()
    };
}

/** Let it in, or turn it away. False when there was nothing waiting under the
 *  code any more - answered, expired or never there. */
export async function answerCliSignIn(input: {
    readonly userId: string;
    readonly userCode: string;
    readonly approve: boolean;
}): Promise<boolean> {
    const answered = await prisma.cliAuthorization.updateMany({
        where: { userCode: input.userCode, status: "pending", expiresAt: { gt: new Date() } },
        data: { status: input.approve ? "approved" : "denied", userId: input.userId }
    });
    return answered.count > 0;
}

/**
 * Collect an approval and become a credential.
 *
 * The scopes are narrowed here, to what the account holds now: the request was
 * the CLI's to word, the approval was for this account, and a key never carries
 * more than its owner. Nothing left after that is a refusal rather than a key
 * that can do nothing.
 */
export async function claimCliSignIn(
    deviceCode: string,
    now = new Date()
): Promise<ClaimedCliSignIn> {
    const row = await prisma.cliAuthorization.findUnique({
        where: { codeHash: hashToken(deviceCode) }
    });
    if (!row) return { status: "expired" };
    if (row.expiresAt <= now) {
        await prisma.cliAuthorization.deleteMany({ where: { id: row.id } });
        return { status: "expired" };
    }
    if (row.status === "denied") {
        await prisma.cliAuthorization.deleteMany({ where: { id: row.id } });
        return { status: "denied" };
    }
    if (row.status !== "approved" || !row.userId) return { status: "pending" };

    // Spent before anything is minted: two polls racing on one approval must not
    // both walk away with a key. Whoever deletes the row is the one collector.
    const spent = await prisma.cliAuthorization.deleteMany({
        where: { id: row.id, status: "approved" }
    });
    if (spent.count === 0) return { status: "expired" };

    const account = await prisma.user.findUnique({
        where: { id: row.userId },
        select: {
            id: true,
            name: true,
            email: true,
            bannedAt: true,
            disabledAt: true,
            isAdmin: true
        }
    });
    if (!account || account.bannedAt || account.disabledAt) return { status: "denied" };

    const held = new Set<string>(await scopesAvailableTo(account.id, account.isAdmin));
    const scopes = storedScopes(row.scopes).filter((scope) => held.has(scope));
    if (scopes.length === 0) return { status: "denied" };

    // The schema supplies every default a key needs; the scopes are then put
    // back to exactly the ones the approval screen listed. The schema would
    // widen them with what each one implies (deploy.manage implies the game
    // server scopes), and a key must not carry anything the person saying yes
    // was not shown.
    const input = {
        ...createApiKeySchema.parse({
            // i18n-ignore the name of a key, in the list its owner reads
            name: `CLI - ${row.deviceName}`.slice(0, 60),
            // i18n-ignore stored with the key; the list shows it as written
            description: "Signed in with plr login.",
            environment: "development",
            scopes,
            expiresInDays: CLI_TOKEN_DAYS
        }),
        scopes
    };
    const created = await createApiKey(account.id, input, { kind: "cli" });
    return {
        status: "approved",
        token: created.secret,
        keyId: created.id,
        scopes,
        account: { id: account.id, name: account.name ?? "", email: account.email }
    };
}

/**
 * End the sign-in a CLI is presenting, which is what `plr logout` asks for.
 *
 * Only a key of kind "cli": a key made on the API keys screen and handed to the
 * CLI through `POLARIS_TOKEN` is very likely wired into something else as well,
 * and logging out of a terminal must not break a deploy pipeline.
 */
export async function endCliSignIn(principal: {
    readonly keyId: string;
    readonly userId: string;
    readonly kind: string;
}): Promise<boolean> {
    if (principal.kind !== "cli") return false;
    await revokeApiKey(principal.userId, principal.keyId);
    return true;
}
