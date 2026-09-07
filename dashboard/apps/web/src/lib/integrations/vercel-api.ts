/**
 * The Vercel REST API, as much of it as Polaris needs.
 *
 * Polaris is a control plane, not a second build farm: a service running on
 * Vercel is built and served by Vercel, and what this reaches for is the part
 * that makes it visible from here - who the token speaks for, which projects it
 * covers, what each one has deployed, and the one action worth having on a screen
 * you are already looking at, which is deploying it again.
 *
 * Every response is parsed against a schema before anything reads it: this is
 * somebody else's server, and a shape that changed under us has to fail here,
 * saying so, rather than three layers further in as an undefined.
 *
 * Server-only. The token never leaves it.
 */

import { z } from "zod";

const API = "https://api.vercel.com";

/** Long enough for a listing on a slow morning, short enough that a screen
 *  waiting on it is not left there. */
const TIMEOUT_MS = 15_000;

/**
 * What went wrong, in a sentence, plus whether the token itself is the problem.
 *
 * The distinction is the reason this is not a plain Error: a refused token has to
 * mark the link and say so on screen, and a listing that timed out has to leave
 * everything exactly where it was.
 */
export class VercelError extends Error {
    readonly kind: "unauthorized" | "refused" | "unreachable";

    constructor(message: string, kind: VercelError["kind"]) {
        super(message);
        this.name = "VercelError";
        this.kind = kind;
    }
}

const userSchema = z.object({
    id: z.string(),
    username: z.string().default(""),
    name: z.string().nullable().default(null),
    email: z.string().default("")
});

export type VercelUser = z.infer<typeof userSchema>;

/**
 * One call, with the token on it.
 *
 * Their own error text is passed through where there is one - "Not authorized"
 * and "The provided token is not valid" are worth reading, and a sentence Polaris
 * invented in their place is not. The token is never in the message: the path is
 * theirs and the header is the secret, and neither is quoted back.
 */
async function call(token: string, path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
        response = await fetch(`${API}${path}`, {
            ...init,
            cache: "no-store",
            signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: {
                ...(init.headers as Record<string, string> | undefined),
                Authorization: `Bearer ${token}`,
                Accept: "application/json",
                ...(init.body === undefined ? {} : { "Content-Type": "application/json" })
            }
        });
    } catch {
        throw new VercelError("Vercel could not be reached. Try again in a moment.", "unreachable");
    }

    const text = await response.text().catch(() => "");
    let payload: unknown = null;
    if (text) {
        try {
            payload = JSON.parse(text) as unknown;
        } catch {
            payload = null;
        }
    }

    if (response.status === 401 || response.status === 403) {
        throw new VercelError(
            detailOf(payload) || "Vercel refused the token. It may have expired or been revoked.",
            "unauthorized"
        );
    }
    if (!response.ok) {
        throw new VercelError(
            detailOf(payload) || `Vercel refused the request (HTTP ${response.status}).`,
            "refused"
        );
    }
    return payload;
}

/** The one line of an error body worth showing. Theirs is `{ error: { message } }`
 *  on every path that has one. */
function detailOf(payload: unknown): string {
    if (!payload || typeof payload !== "object") return "";
    const body = payload as { error?: { message?: unknown } };
    const message = body.error?.message;
    return typeof message === "string" && message.trim() && message.length < 200 ? message.trim() : "";
}

/**
 * Who the token speaks for.
 *
 * The check as well as the answer: Vercel has no endpoint for verifying a token,
 * and asking who it is is the cheapest call there is - so the account a link
 * shows is the one Vercel says the token belongs to, rather than a name somebody
 * typed.
 */
export async function vercelUser(token: string): Promise<VercelUser> {
    const parsed = z
        .object({ user: userSchema })
        .safeParse(await call(token, "/v2/user"));
    if (!parsed.success) throw new VercelError("Vercel answered with something unexpected.", "refused");
    return parsed.data.user;
}
