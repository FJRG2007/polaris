/**
 * How every action that reaches a database answers a failure.
 *
 * Only the refusals Polaris writes for a reader are shown, in the reader's words
 * (`dataText`). Anything else is a fault, and a fault talking to a database
 * describes that database out loud - table names, drivers, connection strings -
 * to whoever happens to be looking. The real one goes to the log, whole, where it
 * is of use. Shared by the Databases app and a Deploy database's panel, so the
 * two cannot drift on what they let through.
 */

import { dataText } from "./words";
import { DataConnectionError } from "./connections";
import { DataRequestError, ReadOnlyError } from "./driver";
import { unstable_rethrow } from "next/navigation";
import { getTranslations } from "@/lib/i18n/request";

export async function guardData<T>(
    run: () => Promise<T>,
    /** Further errors whose message is written for the screen, in English that
     *  `dataText` knows or passes through. */
    spokenToo: (caught: unknown) => boolean = () => false
): Promise<{ value?: T; error?: string }> {
    try {
        return { value: await run() };
    } catch (caught) {
        // A sign-in redirect or a not-found is Next's to handle, not a failure.
        unstable_rethrow(caught);
        const t = await getTranslations("databases");
        const spoken =
            caught instanceof DataConnectionError ||
            caught instanceof ReadOnlyError ||
            caught instanceof DataRequestError;
        if (spoken) return { error: dataText(t, (caught as Error).message) };
        if (spokenToo(caught)) return { error: dataText(t, (caught as Error).message) };
        console.error("databases: an action failed", caught);
        return { error: t("refusals.generic") };
    }
}
