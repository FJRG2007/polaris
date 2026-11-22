/**
 * A Telegram bot's own profile: the name, description, short description and
 * picture people see when they open the chat with it.
 *
 * Every one of these is set by the bot itself through the Bot API with its token
 * (setMyName, setMyDescription, setMyShortDescription, and since Bot API 9.4
 * setMyProfilePhoto), so Polaris can brand the bot without a visit to
 * @BotFather. The token never leaves the server; every call goes through the
 * guarded fetch.
 *
 * Name, description and short description are per language: the value with no
 * language is what everyone sees unless a dedicated one exists for theirs. The
 * Polaris branding writes English as that default and a dedicated Spanish one; a
 * custom value is written as the default and clears the dedicated Spanish one,
 * so it is what everybody sees.
 *
 * Server-only.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { configuredRequest } from "@/lib/safe-fetch";
import { APP_NAME } from "@/lib/integrations/setup-values";

const API_BASE = "https://api.telegram.org";
const CALL_TIMEOUT_MS = 15_000;
/** Telegram expects a square JPG; 640 px is the size its own apps upload. */
const PHOTO_SIZE = 640;

/** The Bot API's own limits (setMyName / setMyDescription / setMyShortDescription). */
export const BOT_NAME_MAX = 64;
export const BOT_DESCRIPTION_MAX = 512;
export const BOT_SHORT_DESCRIPTION_MAX = 120;

export type BotProfileField = "name" | "description" | "shortDescription" | "photo";

export type TelegramFailure =
    | { kind: "rateLimited"; retryAfter: number }
    | { kind: "tokenRefused" }
    | { kind: "unreachable" }
    | { kind: "refused"; description: string };

export interface BotProfile {
    username: string | null;
    name: string;
    description: string;
    shortDescription: string;
    hasPhoto: boolean;
}

export type FieldResult = { field: BotProfileField; ok: true } | { field: BotProfileField; ok: false; failure: TelegramFailure };

export class TelegramCallError extends Error {
    constructor(readonly failure: TelegramFailure) {
        super(failure.kind === "refused" ? failure.description : failure.kind);
    }
}

/** What Polaris writes for each managed language. "" is Telegram's default. */
export const POLARIS_BRANDING: Record<"" | "es", { description: string; shortDescription: string }> = {
    "": {
        description:
            "Polaris sends sign-in codes and alerts through this bot. To link it, open Security in your Polaris account and choose Telegram.",
        shortDescription: "Sign-in codes and alerts from Polaris."
    },
    es: {
        description:
            "Polaris envía los códigos de acceso y los avisos a través de este bot. Para vincularlo, abre Seguridad en tu cuenta de Polaris y elige Telegram.",
        shortDescription: "Códigos de acceso y avisos de Polaris."
    }
};

const answerSchema = z.object({
    ok: z.boolean(),
    result: z.unknown().optional(),
    error_code: z.number().optional(),
    description: z.string().optional(),
    parameters: z.object({ retry_after: z.number().optional() }).optional()
});

/** Telegram's answer as a failure Polaris can word, or null when it succeeded. */
export function failureOf(status: number, answer: z.infer<typeof answerSchema> | null): TelegramFailure | null {
    if (answer?.ok) return null;
    const code = answer?.error_code ?? status;
    const retryAfter = answer?.parameters?.retry_after;
    if (code === 429) return { kind: "rateLimited", retryAfter: Math.max(1, Math.ceil(retryAfter ?? 60)) };
    if (code === 401 || code === 404) return { kind: "tokenRefused" };
    if (!answer) return { kind: "unreachable" };
    return { kind: "refused", description: (answer.description ?? "").replace(/^Bad Request:\s*/i, "").slice(0, 300) };
}

interface Body {
    contentType: string;
    payload: string | Uint8Array;
}

async function call<T>(token: string, method: string, body?: Body): Promise<T> {
    let response: Response;
    try {
        response = await configuredRequest(
            `${API_BASE}/bot${token}/${method}`,
            {
                method: "POST",
                ...(body ? { headers: { "content-type": body.contentType }, body: body.payload as BodyInit } : {}),
                timeoutMs: CALL_TIMEOUT_MS
            },
            { allowPrivate: false }
        );
    } catch {
        throw new TelegramCallError({ kind: "unreachable" });
    }
    const parsed = answerSchema.safeParse(await response.json().catch(() => null));
    const failure = failureOf(response.status, parsed.success ? parsed.data : null);
    if (failure) throw new TelegramCallError(failure);
    return (parsed.success ? parsed.data.result : undefined) as T;
}

function json(value: unknown): Body {
    return { contentType: "application/json", payload: JSON.stringify(value) };
}

/** The bot's profile as people see it in the default language. */
export async function readBotProfile(token: string): Promise<BotProfile> {
    const me = await call<{ id: number; first_name?: string; username?: string }>(token, "getMe");
    const [name, description, shortDescription, photos] = await Promise.all([
        call<{ name?: string }>(token, "getMyName", json({ language_code: "" })),
        call<{ description?: string }>(token, "getMyDescription", json({ language_code: "" })),
        call<{ short_description?: string }>(token, "getMyShortDescription", json({ language_code: "" })),
        call<{ total_count?: number }>(token, "getUserProfilePhotos", json({ user_id: me.id, limit: 1 })).catch(
            () => ({ total_count: 0 })
        )
    ]);
    return {
        username: me.username ?? null,
        name: name.name || me.first_name || "",
        description: description.description ?? "",
        shortDescription: shortDescription.short_description ?? "",
        hasPhoto: (photos.total_count ?? 0) > 0
    };
}

/** The Polaris mark, full bleed: Telegram crops the picture to a circle itself. */
export async function polarisPicture(): Promise<Uint8Array> {
    const box = `0 0 ${core.MARK_SIZE} ${core.MARK_SIZE}`;
    const square = `<rect width="${core.MARK_SIZE}" height="${core.MARK_SIZE}" fill="${core.MARK_BACKGROUND}"/>`;
    const star = `<path d="${core.MARK_STAR}" fill="${core.MARK_FOREGROUND}"/>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${PHOTO_SIZE}" height="${PHOTO_SIZE}" viewBox="${box}">${square}${star}</svg>`;
    const { default: sharp } = await import("sharp");
    const jpeg = await sharp(Buffer.from(svg))
        .resize(PHOTO_SIZE, PHOTO_SIZE)
        .flatten({ background: core.MARK_BACKGROUND })
        .jpeg({ quality: 92 })
        .toBuffer();
    return new Uint8Array(jpeg);
}

/** A multipart body by hand: the guarded fetch is undici's, and a FormData from
 *  the runtime's own undici is not one it is guaranteed to accept. */
export function photoBody(jpeg: Uint8Array, boundary: string): Body {
    const encoder = new TextEncoder();
    const photo = JSON.stringify({ type: "static", photo: "attach://picture" });
    const field = `--${boundary}\r\nContent-Disposition: form-data; name="photo"\r\n\r\n${photo}\r\n`;
    const file = `--${boundary}\r\nContent-Disposition: form-data; name="picture"; filename="polaris.jpg"\r\n`;
    const head = encoder.encode(`${field}${file}Content-Type: image/jpeg\r\n\r\n`);
    const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
    const payload = new Uint8Array(head.length + jpeg.length + tail.length);
    payload.set(head, 0);
    payload.set(jpeg, head.length);
    payload.set(tail, head.length + jpeg.length);
    return { contentType: `multipart/form-data; boundary=${boundary}`, payload };
}

async function settle(field: BotProfileField, steps: (() => Promise<unknown>)[]): Promise<FieldResult> {
    try {
        // In order: a rate limit on the first call stops the second asking again.
        for (const step of steps) await step();
        return { field, ok: true };
    } catch (caught) {
        return {
            field,
            ok: false,
            failure: caught instanceof TelegramCallError ? caught.failure : { kind: "unreachable" }
        };
    }
}

const TEXT_METHODS = {
    name: ["setMyName", "name"],
    description: ["setMyDescription", "description"],
    shortDescription: ["setMyShortDescription", "short_description"]
} as const;

type TextField = keyof typeof TEXT_METHODS;

function setText(token: string, field: TextField, value: string, language: "" | "es") {
    const [method, parameter] = TEXT_METHODS[field];
    return () => call(token, method, json({ [parameter]: value, language_code: language }));
}

/** Brand the bot as Polaris: name, both descriptions in English and Spanish, and the picture. */
export async function applyPolarisBranding(token: string): Promise<FieldResult[]> {
    const texts = (["description", "shortDescription"] as const).map((field) =>
        settle(field, [
            setText(token, field, POLARIS_BRANDING[""][field], ""),
            setText(token, field, POLARIS_BRANDING.es[field], "es")
        ])
    );
    return Promise.all([
        settle("name", [setText(token, "name", APP_NAME, ""), setText(token, "name", APP_NAME, "es")]),
        ...texts,
        settle("photo", [
            async () => {
                const boundary = `polaris${crypto.randomUUID().replace(/-/g, "")}`;
                return call(token, "setMyProfilePhoto", photoBody(await polarisPicture(), boundary));
            }
        ])
    ]);
}

/** Write custom values, one per field given, for every language. */
export async function applyCustomProfile(
    token: string,
    values: Partial<Record<TextField, string>>
): Promise<FieldResult[]> {
    const fields = (Object.keys(TEXT_METHODS) as TextField[]).filter((field) => values[field] !== undefined);
    return Promise.all(
        fields.map((field) =>
            settle(field, [setText(token, field, values[field]!, ""), setText(token, field, "", "es")])
        )
    );
}
