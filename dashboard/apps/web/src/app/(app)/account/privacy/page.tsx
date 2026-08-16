/**
 * Privacy (/account/privacy): what this account shows, and to whom.
 */

import * as core from "@polaris/core";
import { requireUser } from "@/lib/session";
import { PrivacyView } from "./privacy-view";
import { listsFor, namePeople, privacyFor } from "@/lib/privacy-service";

export const dynamic = "force-dynamic";

export default async function PrivacyPage() {
    const session = await requireUser();
    const [settings, lists] = await Promise.all([privacyFor(session.id), listsFor(session.id)]);
    // Every name any rule needs, in one read: a row draws the people it names,
    // and it holds their ids.
    const people = await namePeople(core.PRIVACY_FIELDS.flatMap((field) => settings[field].people));

    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-[17px] font-semibold tracking-tight">Privacy</h1>
                <p className="text-sm text-muted-foreground">
                    Who can find you, who sees your details, and who sees what you are doing.
                    Everything here can be answered with everybody, nobody, or a set of people you
                    name.
                </p>
            </div>
            <PrivacyView settings={settings} lists={lists} people={people} />
        </div>
    );
}
