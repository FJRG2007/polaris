/**
 * Signing in by scanning the QR code on the sign-in screen, from the auth side.
 *
 * The three steps of better-auth's device flow are wrapped here rather than
 * called directly by the app, because each one needs something the plugin does
 * not hand over on its own: opening a code has to say when it expires, answering
 * one has to claim it first, and the exchange that ends it has to leave the
 * waiting browser a session cookie instead of a bearer token.
 *
 * Every function takes the auth instance and plain request headers, so this stays
 * free of any web framework - the caller owns cookies and responses.
 */

import type { Auth } from "./auth.js";
import { APIError } from "better-auth/api";
import { QR_SIGN_IN_CLIENT_ID } from "@polaris/core";
import { parseSetCookieHeader, toCookieOptions } from "better-auth/cookies";

/** A code opened for a waiting sign-in screen. */
export interface DeviceCodeIssued {
    /** The secret the waiting screen polls with. Never shown, never scanned. */
    readonly deviceCode: string;
    /** The short code under the QR, and what the scanned link carries. */
    readonly userCode: string;
    readonly expiresAt: Date;
    /** Milliseconds the waiting screen must leave between polls. */
    readonly pollIntervalMs: number;
}

/** How an exchange ended. Only "approved" carries a session. */
export type DeviceExchange =
    | { readonly status: "approved"; readonly cookies: readonly IssuedCookie[] }
    | { readonly status: "pending" | "denied" | "expired" };

/** A cookie better-auth issued, in the shape a response layer can set. */
export interface IssuedCookie {
    readonly name: string;
    readonly value: string;
    readonly options: {
        maxAge?: number;
        expires?: Date;
        domain?: string;
        path?: string;
        secure?: boolean;
        httpOnly?: boolean;
        sameSite?: "lax" | "strict" | "none";
        partitioned?: boolean;
    };
}

/**
 * The device-flow endpoints as this package calls them.
 *
 * Named here rather than inferred for the same reason buildPlugins types its
 * plugins as the base: the endpoints carry better-auth's own nested zod through
 * their signatures, which this package cannot reproduce in the declarations it
 * emits. Nothing is loosened by writing them out - a plugin that moved or renamed
 * one of these would fail the device-login tests rather than at a call site.
 */
interface DeviceFlowApi {
    deviceCode(input: { body: { client_id: string } }): Promise<{
        device_code: string;
        user_code: string;
        expires_in: number;
        interval: number;
    }>;
    deviceVerify(input: { query: { user_code: string }; headers: Headers }): Promise<unknown>;
    deviceApprove(input: { body: { userCode: string }; headers: Headers }): Promise<unknown>;
    deviceDeny(input: { body: { userCode: string }; headers: Headers }): Promise<unknown>;
    deviceToken(input: {
        body: { grant_type: string; device_code: string; client_id: string };
        headers: Headers;
        returnHeaders: true;
    }): Promise<{ headers: Headers }>;
}

function deviceFlow(auth: Auth): DeviceFlowApi {
    return auth.api as unknown as DeviceFlowApi;
}

/** Open a code for a sign-in screen that is about to show a QR. */
export async function openDeviceCode(auth: Auth): Promise<DeviceCodeIssued> {
    const issued = await deviceFlow(auth).deviceCode({ body: { client_id: QR_SIGN_IN_CLIENT_ID } });
    return {
        deviceCode: issued.device_code,
        userCode: issued.user_code,
        expiresAt: new Date(Date.now() + issued.expires_in * 1000),
        pollIntervalMs: issued.interval * 1000
    };
}

/**
 * Claim a scanned code for the session in `headers`, so only that account can
 * answer it. Returns false when the code is unknown, expired, or already claimed
 * by somebody else - the caller says so without saying which, since the person
 * holding the code has no business learning anything about another account.
 */
export async function claimDeviceCode(auth: Auth, userCode: string, headers: Headers): Promise<boolean> {
    try {
        await deviceFlow(auth).deviceVerify({ query: { user_code: userCode }, headers });
        return true;
    } catch {
        return false;
    }
}

/** Answer a claimed code. The caller has already proved who it is and that they
 *  meant it; this only records the decision. */
export async function decideDeviceCode(
    auth: Auth,
    userCode: string,
    approve: boolean,
    headers: Headers
): Promise<{ error?: string }> {
    try {
        if (approve) await deviceFlow(auth).deviceApprove({ body: { userCode }, headers });
        else await deviceFlow(auth).deviceDeny({ body: { userCode }, headers });
        return {};
    } catch (error) {
        return { error: deviceErrorMessage(error) };
    }
}

/**
 * Spend an approved code: create the session for the waiting browser and hand
 * back the cookies that sign it in.
 *
 * The cookies come from better-auth itself (a hook on the exchange sets them,
 * since the flow was written to answer with a bearer token) and are only carried
 * across to the response here, never rebuilt - the session cookie is signed, and
 * a second implementation of that signing is a second thing to get wrong.
 */
export async function exchangeDeviceCode(
    auth: Auth,
    deviceCode: string,
    headers: Headers
): Promise<DeviceExchange> {
    try {
        const { headers: issued } = await deviceFlow(auth).deviceToken({
            body: {
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                device_code: deviceCode,
                client_id: QR_SIGN_IN_CLIENT_ID
            },
            headers,
            returnHeaders: true
        });
        return { status: "approved", cookies: readIssuedCookies(issued) };
    } catch (error) {
        return { status: exchangeOutcome(error) };
    }
}

/** Every Set-Cookie a better-auth call produced, ready to be put on a response.
 *  Shared with the connection sign-in, which carries cookies across the same way
 *  and for the same reason: the session cookie is signed, and a second
 *  implementation of that signing is a second thing to get wrong. */
export function readIssuedCookies(headers: Headers): IssuedCookie[] {
    const cookies: IssuedCookie[] = [];
    for (const header of headers.getSetCookie()) {
        for (const [name, attributes] of parseSetCookieHeader(header)) {
            const options = toCookieOptions(attributes);
            cookies.push({
                name,
                value: attributes.value,
                options: {
                    ...options,
                    sameSite: normalizeSameSite(options.sameSite)
                }
            });
        }
    }
    return cookies;
}

/** Set-Cookie carries the value as written; a response API wants the union. */
function normalizeSameSite(value: unknown): IssuedCookie["options"]["sameSite"] {
    return value === "lax" || value === "strict" || value === "none" ? value : undefined;
}

/**
 * What a refused exchange means for the waiting screen. Anything the flow does
 * not recognize is treated as an ended code rather than a state to keep polling
 * on, so a screen can never sit there forever on an error nobody is watching.
 */
function exchangeOutcome(error: unknown): "pending" | "denied" | "expired" {
    switch (deviceErrorCode(error)) {
        case "authorization_pending":
        case "slow_down":
            return "pending";
        case "access_denied":
            return "denied";
        default:
            return "expired";
    }
}

/** The machine-readable code on a device-flow failure, when there is one. */
function deviceErrorCode(error: unknown): string | null {
    if (!(error instanceof APIError)) return null;
    const body = error.body as { error?: unknown } | undefined;
    return typeof body?.error === "string" ? body.error : null;
}

/** What to tell somebody whose decision did not land. */
function deviceErrorMessage(error: unknown): string {
    switch (deviceErrorCode(error)) {
        case "expired_token":
            return "That code has expired. Ask for a new one on the sign-in screen.";
        case "device_code_already_processed":
            return "That code has already been answered.";
        default:
            return "That code is no longer valid.";
    }
}
