/**
 * Every UPS with what it says now - a USB one a machine sees is added by itself -
 * and the USB ones somebody removed, offered again. Polled by the UPS list while
 * it is open, which is why this is a route: an action id does not survive the
 * update a long-lived tab outlives.
 *
 * A denial answers 403 rather than redirecting, as a fetched route must.
 */

import { sessionCan } from "@/lib/session";
import { apiUser } from "@/lib/api-session";
import { readerWords } from "@/lib/i18n/reader-words";
import * as upsService from "@/lib/ups/ups-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    if (!user.isAdmin && !(await sessionCan(user, "system.manage"))) {
        return Response.json(
            { error: (await readerWords("api"))("errors.forbidden") },
            { status: 403 }
        );
    }
    const listUsb = upsService.usbListing();
    // One plugged in since the last watcher pass shows up the moment the list is open.
    await upsService.adoptUsb(listUsb).catch(() => 0);
    const ups = await upsService.upsSnapshot(listUsb);
    const usb = await upsService.dismissedOffers(
        await upsService.usbOffers(
            ups.map((entry) => entry.ups),
            listUsb
        )
    );
    return Response.json({ ups, usb });
}
