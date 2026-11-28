/**
 * `/hospitality-link`: the address a handheld, till or kitchen screen is left
 * open on. Outside sign-in (core draws it as a public page): unlinked it shows
 * the code to type on the Devices tab, linked it opens straight into the work.
 * What a linked device may do is decided by each action, for its venue only.
 */

import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { deviceFromToken } from "../../../lib/devices";
import { DEVICE_COOKIE } from "../../../model/device-link";
import { DeviceWork, LinkScreen } from "../../../screens/device-screens";

export const dynamic = "force-dynamic";

export default async function HospitalityLinkPage({ params }: { params: Promise<Record<string, string | string[]>> }) {
    const path = (await params).path;
    if (path && (!Array.isArray(path) || path.length > 0)) notFound();
    const token = (await cookies()).get(DEVICE_COOKIE)?.value;
    const device = token ? await deviceFromToken(token) : null;
    return device ? <DeviceWork name={device.name} /> : <LinkScreen />;
}
