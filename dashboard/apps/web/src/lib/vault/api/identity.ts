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
import { clientIp, hashForLog } from "@/lib/request-context";
import { readAnyBody, readJsonBody, type VaultContext } from "@/lib/vault/api/router";
import { twoFactorChallengeBody, vaultRefresh, vaultSignIn } from "@/lib/vault/identity";

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
        const result = await vaultRefresh(body.refresh_token ?? "");
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
