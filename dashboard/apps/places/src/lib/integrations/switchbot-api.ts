/**
 * The SwitchBot cloud API (v1.1), as much of it as Places needs.
 *
 * From SwitchBot's own documentation (OpenWonderLabs/SwitchBotAPI). Every request
 * carries the token, a 13-digit timestamp, a nonce, and a signature: the base64
 * HMAC-SHA256 of token + timestamp + nonce under the secret. Their prose says to
 * uppercase it and leaves the nonce out; every one of their code examples does
 * neither, and the code is what their servers accept, so the code is followed.
 *
 * One address, always theirs, so this is the plain fetch the other cloud
 * integrations use rather than the LAN client.
 *
 * The account allows 10,000 calls a day, and going over answers "Unauthorized"
 * exactly as a wrong token does. That is why statuses are held for a few minutes
 * (see `switchbot-cloud`), and why the refusal says both.
 *
 * Server-only.
 */

import { z } from "zod";
import { DriverError } from "../drivers/contract";
import { createHmac, randomUUID } from "node:crypto";

const API_BASE = "https://api.switch-bot.com/v1.1";
const TIMEOUT_MS = 15_000;

export interface SwitchBotCredentials {
    readonly token: string;
    readonly secret: string;
}

/** The signature, as their code examples compute it. */
export function switchBotSign(token: string, secret: string, t: string, nonce: string): string {
    return createHmac("sha256", secret).update(`${token}${t}${nonce}`, "utf8").digest("base64");
}

const envelopeSchema = z.object({
    statusCode: z.number().int(),
    message: z.string().optional(),
    body: z.unknown().optional()
});

function refusedKeys(): DriverError {
    return new DriverError(
        "SwitchBot refused the token and secret. They may have been reset in the app, or today's allowance of requests is used up.",
        "unauthorized"
    );
}

async function call(
    credentials: SwitchBotCredentials,
    method: "GET" | "POST",
    path: string,
    body?: unknown
): Promise<unknown> {
    const t = Date.now().toString();
    const nonce = randomUUID();
    let response: Response;
    try {
        response = await fetch(`${API_BASE}${path}`, {
            method,
            cache: "no-store",
            signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: {
                Authorization: credentials.token,
                sign: switchBotSign(credentials.token, credentials.secret, t, nonce),
                t,
                nonce,
                ...(body !== undefined ? { "Content-Type": "application/json; charset=utf8" } : {})
            },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
    } catch {
        throw new DriverError(
            "SwitchBot could not be reached. Try again in a moment.",
            "unreachable"
        );
    }
    if (response.status === 401 || response.status === 403) throw refusedKeys();
    if (response.status === 429) {
        throw new DriverError(
            "SwitchBot is answering too many requests at once. Try again in a minute.",
            "unreachable"
        );
    }

    let payload: unknown = null;
    try {
        payload = JSON.parse(await response.text()) as unknown;
    } catch {
        payload = null;
    }
    const parsed = envelopeSchema.safeParse(payload);
    if (!parsed.success)
        throw new DriverError("SwitchBot answered with something unexpected.", "refused");
    const code = parsed.data.statusCode;
    if (code === 100) return parsed.data.body;
    // 161 is the device offline, 171 the hub it talks through.
    if (code === 161 || code === 171) {
        throw new DriverError("The device is not answering SwitchBot right now.", "unreachable");
    }
    throw new DriverError("SwitchBot refused the request.", "refused");
}

const deviceSchema = z
    .object({
        deviceId: z.string(),
        deviceName: z.string().default(""),
        deviceType: z.string().default(""),
        enableCloudService: z.boolean().default(true),
        hubDeviceId: z.string().optional()
    })
    .passthrough();

export type SwitchBotDevice = z.infer<typeof deviceSchema>;

/** Every physical device on the account. The infrared remotes listed beside
 *  them are not devices anything can read back from, and are left out. */
export async function switchBotDevices(
    credentials: SwitchBotCredentials
): Promise<SwitchBotDevice[]> {
    const body = z
        .object({ deviceList: z.array(z.unknown()).default([]) })
        .passthrough()
        .safeParse(await call(credentials, "GET", "/devices"));
    if (!body.success)
        throw new DriverError("SwitchBot answered with something unexpected.", "refused");
    return body.data.deviceList.flatMap((item) => {
        const parsed = deviceSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
    });
}

/** One device's status, whose fields depend on what it is. */
export async function switchBotStatus(
    credentials: SwitchBotCredentials,
    deviceId: string
): Promise<Record<string, unknown>> {
    const body = await call(credentials, "GET", `/devices/${encodeURIComponent(deviceId)}/status`);
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

/** Send a command, with the default parameter their examples use. */
export async function switchBotCommand(
    credentials: SwitchBotCredentials,
    deviceId: string,
    command: string
): Promise<void> {
    await call(credentials, "POST", `/devices/${encodeURIComponent(deviceId)}/commands`, {
        command,
        parameter: "default",
        commandType: "command"
    });
}
