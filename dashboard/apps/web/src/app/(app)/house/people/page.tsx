/**
 * The people the house knows by sight.
 */

import { PageHeader } from "@polaris/ui";
import { PeopleView } from "./people-view";
import { requireHomeUser } from "@/lib/home/access";

export const dynamic = "force-dynamic";

export default async function PeoplePage() {
    const { canManage } = await requireHomeUser("home.read");

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            <PageHeader
                title="People"
                description="Teach the cameras who lives here, so everybody else is the one worth reporting. The photographs stay on the machine running the recognizer."
            />
            <PeopleView canManage={canManage} />
        </div>
    );
}
