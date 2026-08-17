/**
 * What the cameras noticed.
 *
 * The wall answers "what is happening"; this answers "what happened", which is
 * the question somebody actually opens Polaris for after the fact.
 */

import { PageHeader } from "@polaris/ui";
import { EventsView } from "./events-view";
import { requireHomeUser } from "@/lib/home/access";

export const dynamic = "force-dynamic";

export default async function EventsPage() {
    const { canControl } = await requireHomeUser("home.read");

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            <PageHeader title="Events" description="Everything the cameras noticed, newest first." />
            <EventsView canControl={canControl} />
        </div>
    );
}
