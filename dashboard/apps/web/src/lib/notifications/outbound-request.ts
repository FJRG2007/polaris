/**
 * The extra headers and the sign-in a signed webhook sends with every body.
 *
 * The model is the one n8n, Zapier and most receivers converged on: one auth
 * choice - none, a Bearer token, Basic user and password, or a header name and
 * value - plus a free list of extra headers, any of which may be marked secret.
 * Polaris's own HMAC signature is sent either way and cannot be replaced.
 *
 * Stored in two halves: `requestConfig` holds what may be shown again (names,
 * the auth type, the Basic user, values not marked secret); every token,
 * password and secret value is one envelope-encrypted JSON object that only the
 * sender opens. The page is told that a secret is set, never what it is.
 */

import { z } from "zod";
import { isReservedWebhookHeader, type WebhookRequestInput } from "@polaris/core";

/** The shown half, as stored. */
export interface RequestConfig {
    auth:
        | { type: "none" }
        | { type: "bearer" }
        | { type: "basic"; username: string }
        | { type: "header"; name: string };
    headers: Array<{ name: string; secret: boolean; value: string | null }>;
}

/** The secret half, as stored once decrypted. Header values keyed by lower-case name. */
export interface RequestSecrets {
    token?: string;
    password?: string;
    value?: string;
    headers: Record<string, string>;
}

/** What the page sees: whether each secret is set, never the secret. */
export interface WebhookRequestView {
    auth:
        | { type: "none" }
        | { type: "bearer"; tokenSet: boolean }
        | { type: "basic"; username: string; passwordSet: boolean }
        | { type: "header"; name: string; valueSet: boolean };
    headers: Array<{ name: string; secret: boolean; value: string | null; set: boolean }>;
}

export const EMPTY_CONFIG: RequestConfig = { auth: { type: "none" }, headers: [] };

const storedConfigSchema = z.object({
    auth: z.discriminatedUnion("type", [
        z.object({ type: z.literal("none") }),
        z.object({ type: z.literal("bearer") }),
        z.object({ type: z.literal("basic"), username: z.string() }),
        z.object({ type: z.literal("header"), name: z.string() })
    ]),
    headers: z.array(
        z.object({ name: z.string(), secret: z.boolean(), value: z.string().nullable() })
    )
});

const storedSecretsSchema = z.object({
    token: z.string().optional(),
    password: z.string().optional(),
    value: z.string().optional(),
    headers: z.record(z.string(), z.string()).default({})
});

/** A stored config read whole or not at all: a row older than this code, or one
 *  somebody wrote by hand, reads as no extra headers rather than half of them. */
export function readConfig(value: unknown): RequestConfig {
    const parsed = storedConfigSchema.safeParse(value);
    return parsed.success ? parsed.data : EMPTY_CONFIG;
}

export function readSecrets(json: string | null): RequestSecrets {
    if (!json) return { headers: {} };
    try {
        const parsed = storedSecretsSchema.safeParse(JSON.parse(json));
        return parsed.success ? parsed.data : { headers: {} };
    } catch {
        return { headers: {} };
    }
}

export function requestView(config: RequestConfig, secrets: RequestSecrets): WebhookRequestView {
    const auth = config.auth;
    return {
        auth:
            auth.type === "bearer"
                ? { type: "bearer", tokenSet: Boolean(secrets.token) }
                : auth.type === "basic"
                  ? {
                        type: "basic",
                        username: auth.username,
                        passwordSet: Boolean(secrets.password)
                    }
                  : auth.type === "header"
                    ? { type: "header", name: auth.name, valueSet: Boolean(secrets.value) }
                    : { type: "none" },
        headers: config.headers.map((header) => ({
            name: header.name,
            secret: header.secret,
            value: header.secret ? null : header.value,
            set: header.secret ? Boolean(secrets.headers[header.name.toLowerCase()]) : true
        }))
    };
}

/** The view without the secret half: a set flag stands for "configured", since a
 *  secret is only ever stored together with its config. */
export function configView(config: RequestConfig): WebhookRequestView {
    return requestView(config, {
        token: "set",
        password: "set",
        value: "set",
        headers: Object.fromEntries(
            config.headers.map((header) => [header.name.toLowerCase(), "set"])
        )
    });
}

/**
 * Apply what the page sent over what is stored. A secret left out keeps the
 * stored one; one that was never stored is refused rather than sent empty.
 */
export function mergeRequest(
    input: WebhookRequestInput,
    stored: RequestSecrets
): { config: RequestConfig; secrets: RequestSecrets } | { error: "missingSecret" } {
    const secrets: RequestSecrets = { headers: {} };
    let auth: RequestConfig["auth"];
    switch (input.auth.type) {
        case "bearer":
            secrets.token = input.auth.token ?? stored.token;
            if (!secrets.token) return { error: "missingSecret" };
            auth = { type: "bearer" };
            break;
        case "basic":
            secrets.password = input.auth.password ?? stored.password;
            if (!secrets.password) return { error: "missingSecret" };
            auth = { type: "basic", username: input.auth.username };
            break;
        case "header":
            secrets.value = input.auth.value ?? stored.value;
            if (!secrets.value) return { error: "missingSecret" };
            auth = { type: "header", name: input.auth.name };
            break;
        default:
            auth = { type: "none" };
    }
    const headers: RequestConfig["headers"] = [];
    for (const header of input.headers) {
        if (!header.secret) {
            headers.push({ name: header.name, secret: false, value: header.value ?? "" });
            continue;
        }
        const key = header.name.toLowerCase();
        const value = header.value ?? stored.headers[key];
        if (!value) return { error: "missingSecret" };
        secrets.headers[key] = value;
        headers.push({ name: header.name, secret: true, value: null });
    }
    return { config: { auth, headers }, secrets };
}

/**
 * The headers to send, before Polaris's own. Anything reserved is dropped here
 * as well as at the door, so a stored row can never displace the signature.
 */
export function requestHeaders(
    config: RequestConfig,
    secrets: RequestSecrets
): Record<string, string> {
    const out: Record<string, string> = {};
    const put = (name: string, value: string | undefined) => {
        if (!value || isReservedWebhookHeader(name) || /[\r\n\0]/.test(value)) return;
        out[name] = value;
    };
    for (const header of config.headers) {
        put(
            header.name,
            header.secret ? secrets.headers[header.name.toLowerCase()] : (header.value ?? undefined)
        );
    }
    const auth = config.auth;
    if (auth.type === "bearer") put("Authorization", secrets.token && `Bearer ${secrets.token}`);
    if (auth.type === "basic" && secrets.password) {
        const pair = Buffer.from(`${auth.username}:${secrets.password}`, "utf8").toString("base64");
        put("Authorization", `Basic ${pair}`);
    }
    if (auth.type === "header") put(auth.name, secrets.value);
    return out;
}
