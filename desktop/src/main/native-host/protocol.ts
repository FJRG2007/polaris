/**
 * What the native messaging host (`crates/polaris-native-host`) may say to
 * this app over the local socket, and what it is answered.
 *
 * The same framing the browsers use: a 32-bit little-endian length, then that
 * many bytes of JSON. Exactly one message per connection, and only two are
 * accepted: a pairing nonce from the extension (relayed by the host), and a
 * Polaris Terminal on this computer handing over its sign-in code
 * (`terminal-sign-in`), which connects to the socket itself. Everything else - a frame over the size cap,
 * bytes that are not JSON, any other shape - is answered `bad-request` and the
 * connection is closed.
 *
 * Pure, so the tests can feed it bytes.
 */

import { z } from "zod";
import {
    CHROMIUM_EXTENSION_ID_PATTERN,
    NATIVE_MESSAGE_MAX_BYTES,
    PAIRING_NONCE_PATTERN,
    type NativePairReply
} from "../../../../dashboard/packages/core/src/device-pairing";

/** The extension that started the host, as its browser named it. */
export const callerSchema = z.discriminatedUnion("browser", [
    z.object({ browser: z.literal("chromium"), id: z.string().regex(CHROMIUM_EXTENSION_ID_PATTERN) }),
    z.object({ browser: z.literal("firefox"), id: z.string().min(1).max(255).regex(/^[A-Za-z0-9@._{}-]+$/) })
]);
export type NativeCaller = z.infer<typeof callerSchema>;

/** The server's origin: an http(s) URL reduced to scheme, host and port. */
const serverSchema = z
    .string()
    .max(2048)
    .transform((value, context) => {
        try {
            const url = new URL(value);
            if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
        } catch {
            // Reported below.
        }
        context.addIssue({ code: "custom", message: "not a web origin" });
        return z.NEVER;
    });

export const pairMessageSchema = z.strictObject({
    type: z.literal("pair"),
    server: serverSchema,
    nonce: z.string().regex(PAIRING_NONCE_PATTERN),
    caller: callerSchema
});
export type PairMessage = z.infer<typeof pairMessageSchema>;

/** A sign-in code, as the server issues them: eight letters, maybe grouped. */
const userCodeSchema = z.string().max(16).regex(/^[A-Za-z]{4}-?[A-Za-z]{4}$/);

export const terminalSignInSchema = z.strictObject({
    type: z.literal("terminal-sign-in"),
    server: serverSchema,
    userCode: userCodeSchema
});
export type TerminalSignInMessage = z.infer<typeof terminalSignInSchema>;

export type HostMessage = PairMessage | TerminalSignInMessage;

const hostMessageSchema = z.union([pairMessageSchema, terminalSignInSchema]);

export type FrameRead =
    | { readonly kind: "partial"; }
    | { readonly kind: "message"; readonly message: HostMessage; }
    | { readonly kind: "invalid"; readonly why: string; };

/** Read the one message a connection carries from the bytes received so far. */
export function readFrame(received: Buffer): FrameRead {
    if (received.length < 4) return { kind: "partial" };
    const length = received.readUInt32LE(0);
    if (length > NATIVE_MESSAGE_MAX_BYTES) return { kind: "invalid", why: `a ${length}-byte message is over the limit` };
    if (received.length < 4 + length) return { kind: "partial" };
    if (received.length > 4 + length) return { kind: "invalid", why: "more than one message" };
    let parsed: unknown;
    try {
        parsed = JSON.parse(received.subarray(4).toString("utf8"));
    } catch {
        return { kind: "invalid", why: "not JSON" };
    }
    const message = hostMessageSchema.safeParse(parsed);
    return message.success ? { kind: "message", message: message.data } : { kind: "invalid", why: "not a pairing message" };
}

/** A reply, framed. */
export function frame(reply: NativePairReply): Buffer {
    const body = Buffer.from(JSON.stringify(reply), "utf8");
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(body.length, 0);
    return Buffer.concat([prefix, body]);
}
