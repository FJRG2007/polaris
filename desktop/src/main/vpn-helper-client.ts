/**
 * Talking to the VPN service (`desktop/vpn-helper`): one order per connection on
 * the loopback address. Each side proves the secret by answering the other's
 * challenge, the service first: an order can carry a private key, so nothing is
 * sent until whatever holds the port has shown it is the service. The secret never
 * crosses the socket. No Electron here, so it can be tested against a real socket.
 */

import { z } from "zod";
import { connect } from "node:net";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const HELPER_PORT = 51898;
/** The service version this app speaks; an older one is replaced. */
export const HELPER_VERSION = 1;

const TIMEOUT_MS = 20_000;
const MAX_REPLY = 4096;

const challengeSchema = z.object({ nonce: z.string().min(1).max(128) });
const proofSchema = z.object({ proof: z.string().regex(/^[0-9a-f]{64}$/) });

export const replySchema = z.object({
    ok: z.boolean(),
    code: z.string().max(64).optional(),
    version: z.number().optional(),
    nodeId: z.string().nullable().optional(),
    publicKey: z.string().max(64).optional()
});
export type HelperReply = z.infer<typeof replySchema>;

export function answerFor(secret: string, nonce: string): string {
    return createHmac("sha256", secret).update(nonce).digest("hex");
}

/** What the service answers with. Its own label keeps it from ever being mistaken
 *  for the app's answer to the same nonce. */
export function serviceProof(secret: string, nonce: string, ours: string): string {
    return createHmac("sha256", secret).update(`service\n${nonce}\n${ours}`).digest("hex");
}

function sameProof(proof: string, wanted: string): boolean {
    return timingSafeEqual(Buffer.from(proof), Buffer.from(wanted));
}

/** Sends one order. Null when no service answered it, or it was not the service. */
export function askHelper(
    order: Record<string, unknown> & { readonly order: string; },
    secret: string,
    port = HELPER_PORT
): Promise<HelperReply | null> {
    return new Promise((resolve) => {
        const socket = connect({ host: "127.0.0.1", port });
        let buffer = "";
        const ours = randomBytes(32).toString("hex");
        let nonce: string | null = null;
        let sent = false;
        const finish = (reply: HelperReply | null): void => {
            socket.destroy();
            resolve(reply);
        };
        socket.setTimeout(TIMEOUT_MS, () => finish(null));
        socket.on("error", () => finish(null));
        socket.on("close", () => finish(null));
        socket.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
            if (buffer.length > MAX_REPLY) return finish(null);
            for (;;) {
                const end = buffer.indexOf("\n");
                if (end < 0) return undefined;
                const line = buffer.slice(0, end);
                buffer = buffer.slice(end + 1);
                let parsed: unknown = null;
                try {
                    parsed = JSON.parse(line);
                } catch {
                    return finish(null);
                }
                if (sent) {
                    const reply = replySchema.safeParse(parsed);
                    return finish(reply.success ? reply.data : null);
                }
                if (nonce === null) {
                    const challenge = challengeSchema.safeParse(parsed);
                    if (!challenge.success) return finish(null);
                    nonce = challenge.data.nonce;
                    socket.write(`${JSON.stringify({ nonce: ours })}\n`);
                    continue;
                }
                const proof = proofSchema.safeParse(parsed);
                if (!proof.success) return finish(null);
                if (!sameProof(proof.data.proof, serviceProof(secret, nonce, ours))) {
                    return finish(null);
                }
                sent = true;
                socket.write(`${JSON.stringify({ ...order, answer: answerFor(secret, nonce) })}\n`);
            }
        });
    });
}

export interface Launch {
    readonly file: string;
    readonly args: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
}

/**
 * How to run the installer under the system's own prompt. Paths travel in the
 * environment on the two that go through a script, so none is ever spliced into
 * one.
 */
export function elevatedInstall(platform: string, helper: string, secretFile: string): Launch {
    const env = { POLARIS_VPN_HELPER: helper, POLARIS_VPN_SECRET: secretFile };
    if (platform === "win32") {
        return {
            file: "powershell.exe",
            args: [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                '$p = Start-Process -FilePath $env:POLARIS_VPN_HELPER -ArgumentList "install", (\'"\' + $env:POLARIS_VPN_SECRET + \'"\') -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode'
            ],
            env
        };
    }
    if (platform === "darwin") {
        return {
            file: "/usr/bin/osascript",
            args: [
                "-e",
                'do shell script quoted form of (system attribute "POLARIS_VPN_HELPER") & " install " & quoted form of (system attribute "POLARIS_VPN_SECRET") with administrator privileges'
            ],
            env
        };
    }
    return { file: "pkexec", args: [helper, "install", secretFile] };
}

const SERVER = z
    .string()
    .url()
    .max(2048)
    .refine((value) => /^https?:\/\//.test(value));
const ONE_TIME_KEY = z.string().regex(/^[A-Za-z0-9_-]{8,256}$/);

export const joinSchema = z.object({ server: SERVER, key: ONE_TIME_KEY });

/** Where each system puts the Tailscale client. */
export function tailscalePath(platform: string): string {
    if (platform === "win32") return "C:\\Program Files\\Tailscale\\tailscale.exe";
    if (platform === "darwin") return "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
    return "tailscale";
}

const TEXT = /[^\p{L}\p{N} ._-]/gu;

/** What a computer calls itself on the device list. */
export function deviceNameFrom(hostname: string): string {
    return hostname.replace(TEXT, "").trim().slice(0, 40) || "Computer";
}
