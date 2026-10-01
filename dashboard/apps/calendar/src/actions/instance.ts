"use server";

/** The operator's Calendar settings for everybody on this Polaris. */

import { host } from "@polaris/app-host";
import { calendarT } from "../lib/i18n";
import { CalendarRefusal } from "../lib/errors";
import { requireCalendarUser } from "../lib/access";
import { invalid, outcome, type Outcome } from "../lib/outcome";
import {
    instanceSettingsSchema,
    readInstanceSettings,
    writeInstanceSettings,
    type InstanceSettings
} from "../lib/instance-settings";

/** Everybody with the Calendar reads them: the screens hide what is switched off. */
export async function loadInstanceSettingsAction(): Promise<Outcome<{ settings: InstanceSettings; canManage: boolean }>> {
    return outcome(async () => {
        const user = await requireCalendarUser();
        return {
            settings: await readInstanceSettings(),
            canManage: user.isAdmin || (await host.session.sessionCan(user, "settings.manage"))
        };
    });
}

/** Only somebody who changes instance settings. */
export async function saveInstanceSettingsAction(input: unknown): Promise<Outcome<{ settings: InstanceSettings }>> {
    const parsed = instanceSettingsSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => {
        const user = await requireCalendarUser();
        if (!user.isAdmin && !(await host.session.sessionCan(user, "settings.manage"))) {
            throw new CalendarRefusal((await calendarT())("instance.notAllowed"));
        }
        await writeInstanceSettings(parsed.data);
        return { settings: parsed.data };
    });
}
