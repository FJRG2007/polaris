/**
 * What every `/api/translate` handler does first: a signed-in caller (a
 * session or an API key), held to a rate, and a JSON body no larger than a
 * request may be.
 *
 * Server-only.
 */

import type { z } from "zod";
import { translateT } from "./i18n";
import { host } from "@polaris/app-host";

/** Requests one person may make a minute: a pause in typing is one. */
export const PER_MINUTE = 120;

/** The largest body read, in bytes: the text limits with room for JSON. */
export const BODY_MAX = 256 * 1024;

type Caller = Awaited<ReturnType<typeof host.session.requireUser>>;

/** The caller, or the response that refuses them. */
export async function caller(): Promise<Caller | Response> {
    const user = await host.apiSession.apiUser();
    if (user instanceof Response) return user;
    if (!(await host.session.sessionCan(user, "translate.use"))) {
        const t = await translateT();
        return Response.json(
            { error: "forbidden", message: t("errors.forbidden") },
            { status: 403 }
        );
    }
    const rate = await host.rateLimitService.rateLimit(`translate:${user.id}`, PER_MINUTE, 60_000);
    if (!rate.ok) {
        const t = await translateT();
        return Response.json(
            { error: "rate", message: t("errors.rate") },
            { status: 429, headers: { "retry-after": "60" } }
        );
    }
    return user;
}

/** The body checked against `schema`, or the 4xx that says why not. */
export async function body<T extends z.ZodTypeAny>(
    request: Request,
    schema: T
): Promise<z.infer<T> | Response> {
    const t = await translateT();
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > BODY_MAX) {
        // i18n-ignore a code for the caller; `message` carries the words
        return Response.json({ error: "tooLarge", message: t("errors.tooLong") }, { status: 413 });
    }
    const text = await request.text();
    if (text.length > BODY_MAX) {
        // i18n-ignore a code for the caller; `message` carries the words
        return Response.json({ error: "tooLarge", message: t("errors.tooLong") }, { status: 413 });
    }
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return Response.json({ error: "invalid", message: t("errors.invalid") }, { status: 400 });
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
        return Response.json(
            {
                error: "invalid",
                message: t("errors.invalid"),
                issues: parsed.error.issues.map((issue) => ({
                    path: issue.path.join("."),
                    message: issue.message
                }))
            },
            { status: 400 }
        );
    }
    return parsed.data as z.infer<T>;
}
