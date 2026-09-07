/**
 * The Nuki Web API, as much of it as Places needs.
 *
 * Nuki devices can be reached four ways and only one of them is a fair thing to
 * ask of somebody running Polaris. The hardware Bridge has been discontinued, so
 * building on it is building on a box nobody can buy. MQTT is native to the newer
 * locks but the lock will only connect to a broker on its own LAN, which rules
 * out the office across town and means shipping a broker for the ones it does
 * not. Bluetooth needs a radio within a few metres of the door. Matter over
 * Thread needs a border router and a commissioner.
 *
 * The Web API needs an account and a token, works the same from the next room and
 * from another country, and is the same call whether the lock is a 2.0 behind a
 * bridge or a 4.0 on wifi. So that is what this is, and the rest stay open as
 * drivers to add beside it - which is why nothing above this file knows the word
 * "Nuki".
 *
 * Only the endpoints Places actually uses. Every response is parsed against a
 * schema before anything reads it: this is somebody else's server, and a shape
 * that changed under us has to fail here, saying so, rather than three layers
 * further in as an undefined.
 *
 * Server-only. The token never leaves it.
 */

import { z } from "zod";

const API_BASE = "https://api.nuki.io";

/** Long enough for a lock that is asleep on battery to be woken and answer,
 *  short enough that a screen waiting on it is not left there. */
const TIMEOUT_MS = 20_000;

/**
 * What went wrong, in a sentence, plus whether the token itself is the problem.
 *
 * The distinction is the reason this is not a plain Error: a refused token has to
 * switch the connection off and say so on screen, and a lock that would not
 * answer has to leave everything exactly where it was.
 */
export class NukiError extends Error {
    readonly kind: "unauthorized" | "rate-limited" | "refused" | "unreachable";

    constructor(message: string, kind: NukiError["kind"]) {
        super(message);
        this.name = "NukiError";
        this.kind = kind;
    }
}

const stateSchema = z.object({
    mode: z.number().int().optional(),
    state: z.number().int().optional(),
    trigger: z.number().int().optional(),
    lastAction: z.number().int().optional(),
    batteryCritical: z.boolean().optional(),
    batteryCharging: z.boolean().optional(),
    batteryCharge: z.number().int().optional(),
    keypadBatteryCritical: z.boolean().optional(),
    doorsensorBatteryCritical: z.boolean().optional(),
    doorState: z.number().int().optional(),
    nightMode: z.boolean().optional()
});

const smartlockSchema = z.object({
    smartlockId: z.number(),
    /** 0 Smart Lock 1/2, 1 Box, 2 Opener, 3 Smart Door, 4 Smart Lock 3/4, 5 Smart Lock 5. */
    type: z.number().int(),
    name: z.string().default(""),
    state: stateSchema.optional(),
    firmwareVersion: z.number().int().optional(),
    /** 0 ok, 1 unregistered, 2 auth uuid invalid, 3 auth invalid, 4 offline. */
    serverState: z.number().int().optional(),
    config: z.object({ productVariant: z.number().int().optional() }).optional()
});

const logSchema = z.object({
    id: z.string(),
    smartlockId: z.number().optional(),
    name: z.string().optional(),
    action: z.number().int(),
    trigger: z.number().int(),
    state: z.number().int(),
    autoUnlock: z.boolean().optional(),
    date: z.string()
});

export type NukiSmartlock = z.infer<typeof smartlockSchema>;
export type NukiLog = z.infer<typeof logSchema>;

/**
 * One call, with the token on it.
 *
 * Nuki's own error text is passed through where there is one: "smartlock is busy"
 * is worth reading, and a sentence Polaris invented in its place is not. The
 * token is never in the message - the path is theirs and the header is the
 * secret, and neither is quoted back.
 */
async function call(
    token: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown
): Promise<unknown> {
    let response: Response;
    try {
        response = await fetch(`${API_BASE}${path}`, {
            method,
            cache: "no-store",
            signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/json",
                ...(body === undefined ? {} : { "Content-Type": "application/json" })
            },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
    } catch {
        throw new NukiError("Nuki could not be reached. Try again in a moment.", "unreachable");
    }

    if (response.status === 401 || response.status === 403) {
        throw new NukiError("Nuki refused the token. It may have been revoked.", "unauthorized");
    }
    if (response.status === 429) {
        throw new NukiError("Nuki is answering too many requests at once. Try again in a minute.", "rate-limited");
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

    if (!response.ok) {
        throw new NukiError(detailOf(payload) || `Nuki refused the request (HTTP ${response.status}).`, "refused");
    }
    return payload;
}

/** The one line of an error body worth showing. Nuki answers with `detail` on
 *  some paths and `message` on others, and with nothing at all on a few. */
function detailOf(payload: unknown): string {
    if (!payload || typeof payload !== "object") return "";
    const body = payload as { detail?: unknown; message?: unknown };
    for (const value of [body.detail, body.message]) {
        if (typeof value === "string" && value.trim() && value.length < 200) return value.trim();
    }
    return "";
}

/**
 * Whether a token works, and what it can see.
 *
 * The list is the check: Nuki has no endpoint for verifying one, and asking for
 * the devices is what the connection is for anyway - a token that lists nothing
 * is connected and useless, and the screen has to be able to tell somebody which
 * of the two they have.
 */
export async function listSmartlocks(token: string): Promise<NukiSmartlock[]> {
    const parsed = z.array(smartlockSchema).safeParse(await call(token, "GET", "/smartlock"));
    if (!parsed.success) throw new NukiError("Nuki answered with something unexpected.", "refused");
    return parsed.data;
}

/**
 * Do something to a lock.
 *
 * `action` is Nuki's own numbering - see `NUKI_ACTIONS` - and the call answers as
 * soon as they have accepted it, not when the door has moved. The state that
 * follows comes from the next read, which is why nothing here returns one.
 */
export async function performAction(
    token: string,
    smartlockId: string,
    action: number,
    option = 0
): Promise<void> {
    await call(token, "POST", `/smartlock/${encodeURIComponent(smartlockId)}/action`, { action, option });
}

/**
 * Ask a lock to report where it is, now.
 *
 * Everything else here reads what Nuki last heard from the device, which is as
 * old as the last thing that happened to it - a door locked by hand an hour ago
 * is a door their server may still believe is open.
 *
 * Used only when somebody has asked, never on a timer. Waking a lock over its
 * radio costs battery, and Nuki say so themselves: a background loop calling this
 * is a lock flat in a month. It returns as soon as they have accepted the
 * request, so the state it produces arrives on the read after it rather than in
 * the answer to this.
 */
export async function syncSmartlock(token: string, smartlockId: string): Promise<void> {
    await call(token, "POST", `/smartlock/${encodeURIComponent(smartlockId)}/sync`);
}

/**
 * The account's activity, newest first.
 *
 * Asked for the whole account rather than per lock: a place with six doors is one
 * call instead of six, and what Nuki rate limits is the account.
 */
export async function listLogs(token: string, limit: number): Promise<NukiLog[]> {
    const capped = Math.max(1, Math.min(200, Math.trunc(limit)));
    const parsed = z.array(logSchema).safeParse(await call(token, "GET", `/smartlock/log?limit=${capped}`));
    if (!parsed.success) throw new NukiError("Nuki answered with something unexpected.", "refused");
    return parsed.data;
}

/** Nuki's action numbers for a lock, door or Smart Door - their types 0, 3 and 4. */
export const NUKI_ACTIONS = { unlock: 1, lock: 2, unlatch: 3, lockAndGo: 4 } as const;

/** The firmware as it is written in Nuki's own release notes. Their integer packs
 *  the parts a byte at a time under the major, so 132884 is 2.7.20. */
export function nukiFirmware(version: number | undefined): string | null {
    if (version === undefined || !Number.isInteger(version) || version <= 0) return null;
    return `${version >> 16}.${(version >> 8) & 255}.${version & 255}`;
}
