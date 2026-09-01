/**
 * Devices (/account/devices): the microphone and the camera on this machine.
 *
 * Nothing is read on the server, and there is nothing to read: every answer here
 * is a fact about the browser in front of somebody, kept in that browser. The
 * page exists so the settings have an address people can be sent to when a call
 * goes wrong.
 */

import { requireUser } from "@/lib/session";
import { DevicesView } from "./devices-view";

export const dynamic = "force-dynamic";

export default async function DevicesPage() {
    await requireUser();

    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">Devices</h1>
                <p className="text-sm text-muted-foreground">
                    Which microphone and camera Polaris uses on this machine, and how you sound through
                    them. Kept in this browser, because a headset is plugged into a machine rather than
                    into an account.
                </p>
            </div>
            <DevicesView />
        </div>
    );
}
