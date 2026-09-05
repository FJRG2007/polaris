/**
 * Voice & Video (/account/devices): the microphone and the camera on this
 * machine.
 *
 * Named after what it is for rather than after what it lists. "Devices" is what
 * every other screen in Polaris means when it says the word - the browsers and
 * phones a session is signed in on, which is a security question - and somebody
 * looking for their microphone had no reason to guess that this one meant
 * something else. The path is unchanged: it is in links and in bookmarks, and
 * the name on the screen is what people read.
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
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">Voice &amp; Video</h1>
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
