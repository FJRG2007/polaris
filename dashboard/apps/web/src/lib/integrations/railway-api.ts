/**
 * The Railway public API, as much of it as Polaris needs.
 *
 * One endpoint and one verb: everything Railway exposes is a GraphQL document
 * posted to the same address, which is why this is a query runner rather than a
 * list of paths. Polaris is a control plane here, not a second build farm - what
 * it reaches for is who the token speaks for, which projects it covers, and what
 * each service has deployed.
 *
 * The token matters more than it usually does. Railway has three kinds, and only
 * an account token can answer "who am I" at all: a workspace or project token is
 * scoped to the thing it was made for and refuses the question. That refusal is
 * passed through as their own words rather than dressed up, because it is the one
 * mistake somebody will actually make here.
 *
 * Server-only. The token never leaves it.
 */

import { z } from "zod";

const API = "https://backboard.railway.com/graphql/v2";

const TIMEOUT_MS = 15_000;

export class RailwayError extends Error {
    readonly kind: "unauthorized" | "refused" | "unreachable";

    constructor(message: string, kind: RailwayError["kind"]) {
        super(message);
        this.name = "RailwayError";
        this.kind = kind;
    }
}

const meSchema = z.object({
    id: z.string(),
    name: z.string().nullable().default(null),
    email: z.string().default("")
});

export type RailwayAccount = z.infer<typeof meSchema>;

const envelopeSchema = z.object({
    data: z.unknown().optional(),
    errors: z
        .array(z.object({ message: z.string().default("") }))
        .optional()
});

/**
 * One document, with the token on it.
 *
 * GraphQL answers 200 with an `errors` array for most of what other APIs answer
 * 4xx for, so the status alone says almost nothing: an unauthorized token comes
 * back as a perfectly successful HTTP response carrying "Not Authorized". Both
 * are read, and their own sentence is what reaches the screen.
 */
async function query(token: string, document: string, variables: Record<string, unknown> = {}): Promise<unknown> {
    let response: Response;
    try {
        response = await fetch(API, {
            method: "POST",
            cache: "no-store",
            signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                Accept: "application/json"
            },
            body: JSON.stringify({ query: document, variables })
        });
    } catch {
        throw new RailwayError("Railway could not be reached. Try again in a moment.", "unreachable");
    }

    if (response.status === 401 || response.status === 403) {
        throw new RailwayError("Railway refused the token. It may have been revoked.", "unauthorized");
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

    const parsed = envelopeSchema.safeParse(payload);
    if (!parsed.success) throw new RailwayError("Railway answered with something unexpected.", "refused");

    const complaint = parsed.data.errors?.[0]?.message?.trim();
    if (complaint) {
        // "Not Authorized" is what a workspace or project token gets for asking
        // about an account, and it is the mistake worth naming precisely.
        const unauthorized = /not authori[sz]ed|unauthorized/i.test(complaint);
        throw new RailwayError(
            unauthorized
                ? "Railway did not accept that token for this. An account token reaches every workspace you are in; a workspace or project token cannot answer for the account."
                : complaint,
            unauthorized ? "unauthorized" : "refused"
        );
    }
    if (!response.ok) {
        throw new RailwayError(`Railway refused the request (HTTP ${response.status}).`, "refused");
    }
    return parsed.data.data;
}

/**
 * Who the token speaks for.
 *
 * The check as well as the answer, the same way the other providers here are
 * checked: the account a link shows is the one Railway says the token belongs to,
 * rather than a name somebody typed.
 */
export async function railwayAccount(token: string): Promise<RailwayAccount> {
    const parsed = z
        .object({ me: meSchema })
        .safeParse(await query(token, "query { me { id name email } }"));
    if (!parsed.success) throw new RailwayError("Railway answered with something unexpected.", "refused");
    return parsed.data.me;
}
