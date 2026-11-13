/**
 * A webhook trigger's settings: which methods it answers, how a caller proves
 * itself, who may call it at all, and what it answers with.
 *
 * Prior art: n8n's Webhook node (methods, none/basic/header auth, respond
 * modes, IP allowlist) and the HMAC signatures GitHub and Stripe send.
 *
 * A trigger saved before this existed has no `auth` and is read as "none, as it
 * always was" - its address keeps working exactly as published, and the editor
 * says it should get a check. A trigger added now starts on a header token.
 *
 * The address rules are the ones every public link uses (`link-rules`), plus a
 * deny list, and the client rules are the API keys' (`userAgentRulesSchema`).
 * Secrets are never stored here: they are derived on the server from the
 * master key, the automation, the node and `secretRotation`.
 */

import { z } from "zod";
import { userAgentRulesSchema } from "./schemas/account-security.js";
import { payloadShapeSchema, type PayloadShape } from "./payload-shape.js";
import { cidrOrIp, addressRuleFields } from "./schemas/link-rules.js";

export const WEBHOOK_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

export type WebhookMethod = (typeof WEBHOOK_METHODS)[number];

export const WEBHOOK_AUTH_MODES = ["header", "basic", "hmac", "none"] as const;

export type WebhookAuthMode = (typeof WEBHOOK_AUTH_MODES)[number];

export const WEBHOOK_HMAC_PRESETS = ["github", "stripe", "custom"] as const;

export const WEBHOOK_HMAC_ALGORITHMS = ["sha256", "sha1"] as const;

export const WEBHOOK_RESPOND_MODES = ["immediately", "afterRun"] as const;

/** A header name as HTTP spells one, stored lowercased. */
const headerName = z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9!#$%&'*+.^_`|~-]+$/);

export const webhookAuthSchema = z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("none") }),
    z.object({
        mode: z.literal("header"),
        /** `authorization` expects `Bearer <secret>`; any other header the secret itself. */
        header: headerName.default("authorization")
    }),
    z.object({
        mode: z.literal("basic"),
        username: z
            .string()
            .trim()
            .min(1)
            .max(64)
            .regex(/^[^:\s]+$/)
            .default("polaris")
    }),
    z.object({
        mode: z.literal("hmac"),
        preset: z.enum(WEBHOOK_HMAC_PRESETS).default("custom"),
        header: headerName.default("x-signature-256"),
        algorithm: z.enum(WEBHOOK_HMAC_ALGORITHMS).default("sha256"),
        /** Written before the hex digest, such as GitHub's `sha256=`. */
        prefix: z.string().trim().max(20).default(""),
        /** When set, the signed text is `<timestamp>.<body>` and the timestamp
         *  (Unix seconds) has to be this recent. Empty means body only. */
        timestampHeader: z.union([headerName, z.literal("")]).default(""),
        toleranceSeconds: z.number().int().min(10).max(86_400).default(300)
    })
]);

export type WebhookAuth = z.infer<typeof webhookAuthSchema>;

/** What a preset fixes, applied whenever it is picked. */
export const WEBHOOK_HMAC_PRESET_VALUES: Record<
    Exclude<(typeof WEBHOOK_HMAC_PRESETS)[number], "custom">,
    Omit<Extract<WebhookAuth, { mode: "hmac" }>, "mode" | "preset">
> = {
    github: {
        header: "x-hub-signature-256",
        algorithm: "sha256",
        prefix: "sha256=",
        timestampHeader: "",
        toleranceSeconds: 300
    },
    stripe: {
        header: "stripe-signature",
        algorithm: "sha256",
        prefix: "",
        timestampHeader: "",
        toleranceSeconds: 300
    }
};

const rateWindow = z.object({
    count: z.number().int().min(1).max(100_000),
    windowSeconds: z.number().int().min(1).max(86_400)
});

/** The ceiling a trigger always had, kept as the default so nothing changes. */
export const WEBHOOK_DEFAULT_TOTAL_RATE = { count: 60, windowSeconds: 60 } as const;

/** How large a body may be at most, in KiB: the event payload limit. */
export const WEBHOOK_MAX_BODY_KB = 256;

const statusCode = z.number().int().min(200).max(299);

export const webhookConfigSchema = z.object({
    /** The single method a trigger saved before `methods` existed answered. */
    method: z.enum(["POST", "GET", "any"]).default("POST"),
    /** Any of these; absent means `method` decides, as it always did. */
    methods: z.array(z.enum(WEBHOOK_METHODS)).min(1).max(7).optional(),
    /** Bumped by "New address": the old address stops working. */
    rotation: z.number().int().min(0).max(1_000_000).default(0),
    /** Absent on a trigger saved before checks existed: read as "none". */
    auth: webhookAuthSchema.optional(),
    /** Bumped by "New secret": the old secret stops working. */
    secretRotation: z.number().int().min(0).max(1_000_000).default(0),
    ...addressRuleFields,
    deniedCidrs: z.array(cidrOrIp).max(100).default([]),
    ...userAgentRulesSchema.shape,
    rateLimit: z
        .object({
            perIp: rateWindow.nullable().default(null),
            total: rateWindow.default({ ...WEBHOOK_DEFAULT_TOTAL_RATE })
        })
        .default({ perIp: null, total: { ...WEBHOOK_DEFAULT_TOTAL_RATE } }),
    maxBodyKb: z.number().int().min(1).max(WEBHOOK_MAX_BODY_KB).default(WEBHOOK_MAX_BODY_KB),
    /** Media types accepted, such as `application/json`. Empty means any. */
    contentTypes: z
        .array(
            z
                .string()
                .trim()
                .toLowerCase()
                .regex(/^[a-z0-9.+-]+\/[a-z0-9.+*-]+$/)
        )
        .max(20)
        .default([]),
    /** What the body must look like; "Any" by default, as it always was. */
    bodyShape: payloadShapeSchema.default({ kind: "any" } as PayloadShape),
    /** What the query string must look like (values are strings). */
    queryShape: payloadShapeSchema.default({ kind: "any" } as PayloadShape),
    /** Headers a call must carry, lowercased. */
    requiredHeaders: z.array(headerName).max(20).default([]),
    response: z
        .object({
            mode: z.enum(WEBHOOK_RESPOND_MODES).default("immediately"),
            status: statusCode.default(202),
            /** Sent instead of the default JSON when not empty. */
            body: z.string().max(4000).default("")
        })
        .default({ mode: "immediately", status: 202, body: "" })
});

export type WebhookConfig = z.infer<typeof webhookConfigSchema>;

/** The methods a trigger answers, legacy `method` included. */
export function webhookMethods(config: Pick<WebhookConfig, "method" | "methods">): WebhookMethod[] {
    if (config.methods && config.methods.length > 0) return [...new Set(config.methods)];
    if (config.method === "any") return [...WEBHOOK_METHODS];
    return [config.method];
}

/** The check a trigger applies; a trigger with none saved is "none". */
export function webhookAuth(config: Pick<WebhookConfig, "auth">): WebhookAuth {
    return config.auth ?? { mode: "none" };
}

/** A trigger saved before checks existed, which the editor flags. */
export function webhookIsLegacyOpen(config: Pick<WebhookConfig, "auth">): boolean {
    return config.auth === undefined;
}

/** What a new trigger starts with: a header token, POST only. */
export function newWebhookConfig(): Record<string, unknown> {
    return {
        method: "POST",
        methods: ["POST"],
        rotation: 0,
        auth: { mode: "header", header: "authorization" },
        secretRotation: 0
    };
}

/** Why a delivery was turned away, as the deliveries list names it. */
export const WEBHOOK_REFUSALS = [
    "method",
    "address",
    "country",
    "client",
    "rateLimited",
    "tooLarge",
    "contentType",
    "auth",
    "signatureExpired",
    "invalidJson",
    "headers",
    "shape"
] as const;

export type WebhookRefusal = (typeof WEBHOOK_REFUSALS)[number];

/** The shell variable a copied command reads the secret from. */
export const WEBHOOK_SECRET_PLACEHOLDER = "POLARIS_HOOK_SECRET";

function headerLabel(name: string): string {
    return name.replace(/(^|-)([a-z])/g, (_, dash: string, letter: string) => dash + letter.toUpperCase());
}

/**
 * A curl command that calls the trigger the way it expects to be called: its
 * method, its credential, signed with openssl where it is signed. The secret is
 * a shell variable, never written into the command.
 */
export function webhookCurl(url: string, config: Pick<WebhookConfig, "method" | "methods" | "auth">): string {
    const methods = webhookMethods(config);
    const method =
        methods.find((entry) => entry !== "GET" && entry !== "HEAD" && entry !== "OPTIONS") ??
        methods[0] ??
        "POST";
    const carries = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    const auth = webhookAuth(config);
    const secret = `$${WEBHOOK_SECRET_PLACEHOLDER}`;
    const lines: string[] = [];
    const call: string[] = [`curl -X ${method} '${url}'`];
    if (auth.mode !== "none") lines.push(`${WEBHOOK_SECRET_PLACEHOLDER}='<secret>'`);
    if (carries) {
        lines.push(`BODY='{"hello":"world"}'`);
        call.push(`-H 'Content-Type: application/json'`);
    }
    if (auth.mode === "header")
        call.push(
            auth.header === "authorization"
                ? `-H "Authorization: Bearer ${secret}"`
                : `-H "${headerLabel(auth.header)}: ${secret}"`
        );
    else if (auth.mode === "basic") call.push(`-u "${auth.username}:${secret}"`);
    else if (auth.mode === "hmac") {
        const stamped = auth.preset === "stripe" || auth.timestampHeader !== "";
        const algorithm = auth.preset === "stripe" ? "sha256" : auth.algorithm;
        if (stamped) lines.push("TS=$(date +%s)");
        const text = stamped ? `"$TS.$BODY"` : `"$BODY"`;
        lines.push(
            `SIG=$(printf '%s' ${text} | openssl dgst -${algorithm} -hmac "${secret}" | sed 's/^.* //')`
        );
        if (auth.preset === "stripe") call.push(`-H "${headerLabel(auth.header)}: t=$TS,v1=$SIG"`);
        else {
            call.push(`-H "${headerLabel(auth.header)}: ${auth.prefix}$SIG"`);
            if (auth.timestampHeader) call.push(`-H "${headerLabel(auth.timestampHeader)}: $TS"`);
        }
    }
    if (carries) call.push(`--data-raw "$BODY"`);
    if (carries && auth.mode === "hmac" && !lines.some((line) => line.startsWith("BODY")))
        lines.unshift(`BODY='{"hello":"world"}'`);
    return [...lines, call.join(" \\n  ")].join("\n");
}
