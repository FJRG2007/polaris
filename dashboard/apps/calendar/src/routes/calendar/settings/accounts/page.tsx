/**
 * Linked calendars. The frame is drawn here; the sources are read in the
 * browser. A return from a provider's consent screen carries
 * `?provider=&connection=`, handed to the screen to say once.
 */

import { requireCalendarUser } from "../../../../lib/access";
import { AccountsView } from "../../../../screens/accounts/accounts-view";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string {
    return (Array.isArray(value) ? value[0] : value)?.slice(0, 40) ?? "";
}

export default async function CalendarAccountsPage({
    searchParams
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    await requireCalendarUser();
    const params = await searchParams;
    const connection = one(params.connection);
    const provider = one(params.provider);
    return <AccountsView linked={/^[a-z_]+$/.test(connection) ? connection : null} provider={provider === "microsoft" ? "microsoft" : "google"} />;
}
