/**
 * The identity endpoints: the two a client reaches before it has anything.
 *
 * `prelogin` is unauthenticated by necessity - a client cannot derive a key
 * without knowing how - and answers the same shape for an address with no vault
 * as for one with, so it cannot be used to ask who has an account here.
 *
 * `connect/token` is the sign-in itself. It is OAuth2-shaped because clients
 * expect that, and the grants below are the only ones offered: a password, and a
 * refresh. There is no authorization-code flow because there is nothing to
 * delegate to - Polaris is both sides.
 */

import * as core from "@polaris/core";
import { deviceSchema } from "@polaris/core";
import { preloginFor } from "@/lib/vault/account";
import { rateLimit } from "@/lib/rate-limit-service";
import { readExtensionToken } from "@/lib/extension/sessions";
import { issueClientKey } from "@/lib/vault/client-key";
import { readAnyBody, readJsonBody, type VaultContext } from "@/lib/vault/api/router";
import { clientHost, clientIp, clientUserAgent, hashForLog } from "@/lib/request-context";
import { claimVaultAuthorization, openVaultAuthorization } from "@/lib/vault/authorization";
import {
    issueVaultToken,
    twoFactorChallengeBody,
    vaultRefresh,
    vaultSignIn
} from "@/lib/vault/identity";

/** How a client learns to derive a key for an address. */
export async function prelogin(context: VaultContext): Promise<Response> {
    const body = (await readJsonBody(context.request)) as { email?: unknown } | null;
    const email = typeof body?.email === "string" ? body.email : "";
    const settings = await preloginFor(email);
    return Response.json({
        kdf: settings.kdf,
        kdfIterations: settings.kdfIterations,
        kdfMemory: settings.kdfMemory,
        kdfParallelism: settings.kdfParallelism
    });
}

/** The OAuth2-shaped refusal clients understand. */
function grantError(description: string, status = 400): Response {
    return Response.json(
        { error: "invalid_grant", error_description: description, ErrorModel: null },
        { status }
    );
}

/** Sign in, or refresh. */
export async function connectToken(context: VaultContext): Promise<Response> {
    const body = await readAnyBody(context.request);
    const grant = body.grant_type ?? "";

    if (grant === "refresh_token") {
        // The name is optional and only a label; one that does not pass the
        // device rule is ignored rather than failing the refresh.
        const named = deviceSchema.shape.name.safeParse(body.deviceName);
        const result = await vaultRefresh(body.refresh_token ?? "", named.success ? named.data : null);
        if (!result.ok) return grantError("Refresh token is invalid.");
        return Response.json(result.body);
    }

    if (grant !== "password") {
        // client_credentials is Bitwarden's personal API key, which Polaris does
        // not mint: an API key here would be a second credential for the same
        // vault, with none of the master password's guarantees.
        return grantError("Unsupported grant type.");
    }

    const device = deviceSchema.safeParse({
        identifier: body.deviceIdentifier,
        name: body.deviceName,
        type: body.deviceType,
        pushToken: body.devicePushToken
    });

    const result = await vaultSignIn({
        email: body.username ?? "",
        masterPasswordHash: body.password ?? "",
        device: device.success
            ? { identifier: device.data.identifier, name: device.data.name, type: device.data.type }
            : undefined,
        twoFactorToken: body.twoFactorToken || undefined,
        twoFactorProvider: body.twoFactorProvider ? Number(body.twoFactorProvider) : undefined,
        ipHash: hashForLog(await clientIp()) ?? "unknown"
    });

    if (result.ok) return Response.json(result.body);
    if (result.kind === "two_factor") {
        return Response.json(twoFactorChallengeBody(result.providers), { status: 400 });
    }
    if (result.kind === "rate_limited") {
        return Response.json(
            {
                error: "invalid_grant",
                error_description: "Too many attempts. Try again in a few minutes.",
                ErrorModel: null
            },
            { status: 429, headers: { "retry-after": "900" } }
        );
    }
    return grantError("Username or password is incorrect. Try again.");
}

/**
 * How many requests one address may open, and the window.
 *
 * Opening one is unauthenticated by nature - nobody has said who they are yet - so
 * this is the step a stranger can reach. Loose enough for somebody reinstalling an
 * extension and trying twice, useless for filling the table from outside.
 */
const AUTHORIZE_LIMIT = 20;
const AUTHORIZE_WINDOW_MS = 15 * 60 * 1000;

/**
 * And how often one may poll.
 *
 * Deliberately generous: a request waits five minutes and the extension asks every
 * two seconds, which is a hundred and fifty polls for one sign-in that nothing has
 * gone wrong with. A limit under that would break the ordinary case rather than an
 * abusive one.
 */
const CLAIM_LIMIT = 600;
const CLAIM_WINDOW_MS = 15 * 60 * 1000;

/** The longest public key this will store. An RSA-2048 SPKI in base64 is under 400
 *  characters; the ceiling is here so the column cannot be used as a scratchpad. */
const MAX_PUBLIC_KEY = 2048;

/**
 * Whether a vault key could actually be sealed to this, checked before it is kept.
 *
 * The body of this request is unauthenticated, so the public half is a string a
 * stranger chose. Stored unchecked, the first thing that finds out is the dashboard
 * of whoever opens the approval screen - sealing to it is the one step only that
 * browser can do, and a key that is not a key fails there, in front of a person who
 * asked for none of this. Refused here instead, where the answer costs the asker
 * their own request and nobody else's screen.
 *
 * Done with WebCrypto rather than by pattern, because "parses as an RSA-OAEP SPKI"
 * is the actual requirement and is not something a regular expression can say. This
 * imports a public key to see whether it imports; it decrypts nothing, and there is
 * no private half here to decrypt with.
 */
async function canSealTo(publicKey: string): Promise<boolean> {
    try {
        await crypto.subtle.importKey(
            "spki",
            Buffer.from(publicKey, "base64"),
            // The pair the clients make, and the only one this exchange uses.
            { name: "RSA-OAEP", hash: "SHA-1" },
            false,
            ["encrypt"]
        );
        return true;
    } catch {
        return false;
    }
}

/**
 * Ask to be let in by a browser that is already inside the vault.
 *
 * The extension's way in. What comes back is a code somebody reads out of the
 * popup and a secret to poll with, and neither is worth anything until an unlocked
 * dashboard approves it - see `lib/vault/authorization`.
 */
export async function connectAuthorize(context: VaultContext): Promise<Response> {
    // Counted before anything is read or parsed. Nobody has said who they are yet,
    // and `canSealTo` below is a WebCrypto key import over a string the caller
    // chose: a limit that came after it would bound how many rows a stranger can
    // open while leaving the work in front of them unbounded.
    const ip = await clientIp();
    const throttle = await rateLimit(
        `vault-authorize:${hashForLog(ip) ?? "unknown"}`,
        AUTHORIZE_LIMIT,
        AUTHORIZE_WINDOW_MS
    );
    if (!throttle.ok) return grantError("Too many requests from here. Try again shortly.", 429);

    const body = await readAnyBody(context.request);
    const publicKey = (body.publicKey ?? "").trim();
    // The same parse the password grant does, from the same strings: a client that
    // can sign in one way describes itself the same way in the other.
    const device = deviceSchema.safeParse({
        identifier: body.deviceIdentifier,
        name: body.deviceName,
        type: body.deviceType
    });
    if (publicKey === "" || publicKey.length > MAX_PUBLIC_KEY || !device.success) {
        return grantError("A public key and a device are required.");
    }
    if (!(await canSealTo(publicKey))) {
        return grantError("That public key is not one a vault key can be sealed to.");
    }

    // The extension connects to the account before it asks for a vault, and the
    // token it holds for that is what ties the two together. Optional here
    // because this route is the way in for every client that signs in this way,
    // not only the extension - but a token that IS presented has to be a live
    // one, so a connection somebody ended cannot go on opening vaults.
    const extensionToken = typeof body.extensionToken === "string" ? body.extensionToken : null;
    const connection = extensionToken
        ? await readExtensionToken(extensionToken, {
              ip: ip ?? null,
              userAgent: (await clientUserAgent()) ?? null,
              host: (await clientHost()) ?? null
          })
        : null;
    if (extensionToken && !connection) {
        return grantError(
            "This extension's connection to Polaris has ended. Connect it again.",
            401
        );
    }

    const opened = await openVaultAuthorization(
        {
            publicKey,
            extensionSessionId: connection?.id ?? null,
            deviceIdentifier: device.data.identifier,
            deviceName: device.data.name,
            deviceType: device.data.type,
            // Read off the request rather than taken from the body: what the
            // approval screen shows must not be something the asker wrote.
            requestIp: ip ?? null,
            requestUserAgent: (await clientUserAgent()) ?? null,
            requestHost: (await clientHost()) ?? null
        },
        (size) => crypto.getRandomValues(new Uint8Array(size))
    );
    // Every code drawn was already taken, which is a table full of live requests
    // rather than anything this caller did. Said in the shape the client already
    // handles, so it retries instead of reading an unexplained failure.
    if (!opened) return grantError("Could not start a request just now. Try again.");

    return Response.json({
        userCode: opened.userCode,
        deviceCode: opened.deviceCode,
        expiresAt: opened.expiresAt.toISOString(),
        pollMs: opened.pollMs
    });
}

/**
 * Ask whether it has been approved, and collect the credential when it has.
 *
 * Answers 200 with a status while it is still waiting, because this is a poll
 * rather than an attempt: a refusal shape here would have the extension treating
 * "not yet" as a failure. An approval is spent on the first claim and the row is
 * gone, so this hands over the sealed key exactly once.
 */
export async function connectAuthorizeClaim(context: VaultContext): Promise<Response> {
    const body = await readAnyBody(context.request);
    const deviceCode = (body.deviceCode ?? "").trim();
    if (deviceCode === "") return grantError("A device code is required.");

    const throttle = await rateLimit(
        `vault-authorize-claim:${hashForLog(await clientIp()) ?? "unknown"}`,
        CLAIM_LIMIT,
        CLAIM_WINDOW_MS
    );
    if (!throttle.ok) return grantError("Too many requests from here. Try again shortly.", 429);

    const claim = await claimVaultAuthorization(deviceCode);
    if (claim.status !== "approved" || !claim.claimed) {
        return Response.json({ status: claim.status });
    }

    // The same credential the password grant issues, because it reaches the same
    // surface; what differs is that it was earned in person rather than typed.
    const token = await issueVaultToken(
        claim.claimed.userId,
        claim.claimed.device,
        claim.claimed.extensionSessionId
    );
    // The account credential, so one approval is the whole of it: a client that
    // has just been let in should not then ask for a second sign-in to find out
    // whose account it is on. Absent only when the account holds nothing this
    // could carry, which is what an older client sees anyway; a failure to write
    // one is left to fail, like the token above. The row is already spent by
    // here, so an answer that quietly dropped the field would end a request
    // nothing can revive, telling a client that requires it the account had lost
    // vault access - when asking again was all it needed to do.
    const accountKey = await issueClientKey(claim.claimed.userId, claim.claimed.device);
    return Response.json({
        status: "approved",
        // The account's vault key, sealed to the public half this extension sent.
        // Polaris cannot open it, which is the whole point of the exchange.
        wrappedKey: claim.claimed.wrappedKey,
        ...(accountKey ? { accountKey } : {}),
        ...token
    });
}

/**
 * Registration, refused in words.
 *
 * A vault belongs to a Polaris account, and Polaris has no public registration -
 * an operator invites people. A client offering "create account" would otherwise
 * fail with something unreadable; this says where to go instead.
 */
export async function registerRefusal(): Promise<Response> {
    return Response.json(
        {
            message:
                "Accounts are created in Polaris, not from a client. Sign in to Polaris and set up your vault there.",
            object: "error"
        },
        { status: 400 }
    );
}

/** What a client is told about the server before it signs in. */
export function configResponse(appUrl: string, version: string): Record<string, unknown> {
    return {
        version,
        gitHash: null,
        server: { name: "Polaris", url: "https://github.com/FJRG2007/polaris" },
        environment: {
            vault: `${appUrl}/vault`,
            api: `${appUrl}/vault/api`,
            identity: `${appUrl}/vault/identity`,
            notifications: `${appUrl}/vault/notifications`,
            sso: ""
        },
        featureStates: {},
        settings: { disableUserRegistration: true },
        object: "config"
    };
}

/** The providers this deployment can actually answer with. */
export const SUPPORTED_TWO_FACTOR_PROVIDERS = [core.TWO_FACTOR_AUTHENTICATOR];
