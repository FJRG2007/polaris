/**
 * Open a door from the phone's home-screen widget.
 *
 * GET hands out a challenge for this person and this door; POST opens it
 * against that challenge signed with the phone's own key (`device-proof`), as
 * the signed-in session. The door itself is reached through the Places tool,
 * with every check the Places screen makes (`door-widget`).
 */

import { z } from "zod";
import { apiPermission } from "@/lib/api-session";
import { readerWords } from "@/lib/i18n/reader-words";
import { openDoor, phoneCaller } from "@/lib/mobile/door-widget";
import {
    deviceChallenge,
    deviceProofSchema,
    DeviceProofRefused,
    deviceUsed,
    proveDevice
} from "@/lib/mobile/device-proof";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const deviceIdSchema = z.string().uuid();

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ deviceId: string }> }
): Promise<Response> {
    const user = await apiPermission("home.control");
    if (user instanceof Response) return user;
    const deviceId = deviceIdSchema.safeParse((await params).deviceId);
    if (!deviceId.success) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(
        { challenge: deviceChallenge("door-open", deviceId.data, user.id) },
        { headers: NO_STORE }
    );
}

export async function POST(
    request: Request,
    { params }: { params: Promise<{ deviceId: string }> }
): Promise<Response> {
    const user = await apiPermission("home.control");
    if (user instanceof Response) return user;
    const words = await readerWords("api");
    const deviceId = deviceIdSchema.safeParse((await params).deviceId);
    const proof = deviceProofSchema.safeParse(await request.json().catch(() => null));
    if (!deviceId.success || !proof.success) {
        return Response.json({ error: words("mobile.door.refused.signature") }, { status: 400, headers: NO_STORE });
    }
    let keyId: string;
    try {
        keyId = await proveDevice(user.id, "door-open", deviceId.data, proof.data);
    } catch (error) {
        if (error instanceof DeviceProofRefused) {
            return Response.json(
                { error: words(`mobile.door.refused.${error.reason}`) },
                { status: 403, headers: NO_STORE }
            );
        }
        throw error;
    }
    const outcome = await openDoor(await phoneCaller(user), deviceId.data);
    if (!outcome.ok) {
        const message =
            outcome.message ??
            (outcome.reason === "throttled"
                ? words("mobile.door.throttled")
                : outcome.reason === "missing"
                  ? words("mobile.door.noPlaces")
                  : words("mobile.door.failed"));
        return Response.json(
            { error: message },
            { status: outcome.reason === "throttled" ? 429 : 422, headers: NO_STORE }
        );
    }
    await deviceUsed(keyId);
    return Response.json(
        { ok: true, confirmed: outcome.confirmed, text: words(outcome.confirmed ? "mobile.door.opened" : "mobile.door.sent") },
        { headers: NO_STORE }
    );
}
