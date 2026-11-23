/**
 * Polaris Terminal signing in through this app instead of a browser.
 *
 * The terminal opens its own sign-in request on the server as usual and, when
 * this app is running, hands the code to it over the native-host socket
 * (`{ "type": "terminal-sign-in", server, userCode }`). This app reads what the
 * request asks for (`/api/terminal/authorize/describe`), shows its own
 * confirmation naming the device, system and code, and answers it
 * (`/api/terminal/authorize/answer`) over its own signed-in session. The
 * terminal then collects its own key through the claim, exactly as if the
 * person had approved it on the web page; this app's session never leaves it.
 *
 * Only a request for the server this app is showing is answered, and nothing
 * is approved without the person saying so here. The network calls and the
 * confirmation are injected, so the decisions can be tested.
 */

import { z } from "zod";
import type { TerminalSignInMessage } from "./protocol";
import type { NativePairReply } from "../../../../dashboard/packages/core/src/device-pairing";

export const pendingSchema = z.object({
    userCode: z.string().max(32),
    device: z.string().max(200).nullable(),
    os: z.string().max(100).nullable().optional(),
    clientVersion: z.string().max(100).nullable().optional(),
    scopes: z.array(z.string().max(64)).max(32)
});
export type PendingTerminal = z.infer<typeof pendingSchema>;

export interface TerminalSignInDeps {
    /** The origins this app is showing: its server and, while failed over, the local address in use. */
    readonly servers: () => readonly string[];
    /** POST `path` on `origin` with this app's session: the status and parsed body, or null when unreachable. */
    readonly post: (origin: string, path: string, body: unknown) => Promise<{ status: number; body: unknown } | null>;
    /** Ask the person; true only when they approved it. */
    readonly confirm: (pending: PendingTerminal, server: string) => Promise<boolean>;
}

let asking = false;

function failure(status: number | null): NativePairReply {
    if (status === null) return { ok: false, reason: "unreachable" };
    if (status === 401) return { ok: false, reason: "signed-out" };
    if (status === 400 || status === 415) return { ok: false, reason: "bad-request" };
    return { ok: false, reason: "refused" };
}

export async function answerTerminalSignIn(message: TerminalSignInMessage, deps: TerminalSignInDeps): Promise<NativePairReply> {
    if (!deps.servers().includes(message.server)) return { ok: false, reason: "other-server" };
    const userCode = message.userCode.replace("-", "").toUpperCase();

    const described = await deps.post(message.server, "/api/terminal/authorize/describe", { userCode });
    if (!described || described.status !== 200) return failure(described?.status ?? null);
    const read = z.object({ pending: pendingSchema }).safeParse(described.body);
    if (!read.success) return { ok: false, reason: "bad-request" };

    // One question on screen at a time: a second request while one is open is
    // turned away rather than stacked behind it.
    if (asking) return { ok: false, reason: "refused" };
    asking = true;
    let approve: boolean;
    try {
        approve = await deps.confirm(read.data.pending, message.server);
    } finally {
        asking = false;
    }
    const answered = await deps.post(message.server, "/api/terminal/authorize/answer", { userCode, approve });
    if (!answered || answered.status !== 200) return failure(answered?.status ?? null);
    return approve ? { ok: true } : { ok: false, reason: "refused" };
}
