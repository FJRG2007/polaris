"use server";

/**
 * A signed-out phone holding a "Continue on phone" link: it opens a QR
 * sign-in code, attaches it to the link so the computer can show it, and
 * waits for the PIN there. The link alone never signs anybody in.
 */

import { z } from "zod";
import { clientIp } from "@/lib/request-context";
import { rateLimit } from "@/lib/rate-limit-service";
import { attachSignIn, PAIRING_CODE, readPairing } from "@/lib/agents/session-pairing";
import { openSignInCode, redeemSignInCode, type QrSignInStatus } from "@/lib/qr-sign-in-service";

const codeSchema = z.string().regex(PAIRING_CODE);

export async function startContinueAction(code: unknown): Promise<{ deviceCode: string; pollMs: number } | { error: "gone" | "busy" }> {
    const parsed = codeSchema.safeParse(code);
    if (!parsed.success) return { error: "gone" };
    const limited = await rateLimit(`session-continue:${(await clientIp()) ?? "unknown"}`, 20, 10 * 60 * 1000);
    if (!limited.ok) return { error: "busy" };
    if (!(await readPairing(parsed.data))) return { error: "gone" };
    const opened = await openSignInCode();
    if (!opened.code) return { error: "busy" };
    if (!(await attachSignIn(parsed.data, opened.code.userCode))) return { error: "gone" };
    return { deviceCode: opened.code.deviceCode, pollMs: opened.code.pollMs };
}

export async function pollContinueAction(deviceCode: unknown): Promise<QrSignInStatus> {
    if (typeof deviceCode !== "string" || deviceCode.length === 0 || deviceCode.length > 200) return "expired";
    return redeemSignInCode(deviceCode);
}
