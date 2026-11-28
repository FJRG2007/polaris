/**
 * The device's side of linking, the one Hospitality address a device reaches
 * before it is linked (API routes are not behind the sign-in redirect).
 *
 * `start` makes a link and answers with the code to show; `poll` asks whether
 * the venue's admin approved it, and the first poll after approval sets the
 * device's token as an httpOnly cookie - the token never reaches page script.
 * Neither step reads or changes anything but links, and links are capped, so
 * an anonymous caller can fill nothing.
 */

import { prisma } from "@polaris/db";
import { pollLink, startLink } from "../../../../lib/devices";
import { linkRequest } from "../../../../model/device-schemas";
import { DEVICE_COOKIE, POLL_INTERVAL_MS } from "../../../../model/device-link";

/** Links waiting at once, across the instance: far above any real opening. */
const MAX_OPEN_LINKS = 500;
/** A device token lasts until it is revoked; the cookie is renewed on each link. */
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;

export async function POST(request: Request): Promise<Response> {
    const body = linkRequest.safeParse(await request.json().catch(() => null));
    if (!body.success) return Response.json({ error: "invalid" }, { status: 400 });
    try {
        if (body.data.step === "start") {
            const open = await prisma.hospitalityDeviceLink.count({ where: { expiresAt: { gt: new Date() }, deviceId: null } });
            if (open >= MAX_OPEN_LINKS) return Response.json({ error: "busy" }, { status: 429 });
            return Response.json({ ...(await startLink()), interval: POLL_INTERVAL_MS });
        }
        const polled = await pollLink(body.data.deviceCode);
        if (polled.answer !== "approved" || !polled.token) return Response.json({ status: polled.answer });
        const secure = new URL(request.url).protocol === "https:";
        const cookie = [
            `${DEVICE_COOKIE}=${polled.token}`,
            "Path=/",
            "HttpOnly",
            "SameSite=Lax",
            `Max-Age=${COOKIE_MAX_AGE_S}`,
            ...(secure ? ["Secure"] : [])
        ].join("; ");
        return Response.json({ status: "approved", venueId: polled.venueId }, { headers: { "set-cookie": cookie } });
    } catch (error) {
        console.error("hospitality: a device link step failed:", error);
        return Response.json({ error: "failed" }, { status: 500 });
    }
}
