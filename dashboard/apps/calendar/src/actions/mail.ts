"use server";

/** Whether the reader can write from Polaris Mail, for the addresses an event
 *  shows: a new message there, or the device's own mail app. */

import { host } from "@polaris/app-host";
import { requireCalendarUser } from "../lib/access";
import { outcome, type Outcome } from "../lib/outcome";

export async function mailComposeAction(): Promise<Outcome<{ compose: boolean }>> {
    return outcome(async () => {
        const user = await requireCalendarUser();
        return { compose: await host.session.sessionCan(user, "mail.use") };
    });
}
