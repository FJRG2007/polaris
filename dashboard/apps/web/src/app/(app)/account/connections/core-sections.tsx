/**
 * What Polaris's own apps add to a person's connections hub, beside the
 * installed apps' slots: the trackers Tasks pulls work from and the AI provider
 * keys a model call bills to. Each lists and changes its own rows through its
 * own actions; the hub only gives them one place to be connected from.
 *
 * Personal only. A tracker and a provider key belong to the account that added
 * them - neither can be owned by an organization - so an organization's hub
 * has no section of either.
 */

import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";
import { getTranslations } from "@/lib/i18n/request";
import { AiKeysPanel } from "@/app/(app)/account/ai-keys/ai-keys-panel";
import { listTrackers } from "@/lib/tasks/trackers/service";
import { sessionCan, type SessionUser } from "@/lib/session";
import { AI_KEYS_SECTION, TASK_TRACKERS_SECTION } from "@/lib/connections/hub-href";
import { TrackersView } from "@/app/(app)/tasks/trackers/trackers-view";

export interface HubCoreSections {
    readonly node: ReactNode;
    readonly ids: readonly string[];
}

export async function hubCoreSections(user: SessionUser): Promise<HubCoreSections> {
    const t = await getTranslations("account");
    // The same permission every tracker action asks for, so the section is never
    // offered to somebody its Connect would refuse.
    const trackers = (await sessionCan(user, "tasks.manage")) ? await listTrackers(user.id) : null;
    const sections: { id: string; title: string; intro: string; body: ReactNode }[] = [];
    if (trackers)
        sections.push({
            id: TASK_TRACKERS_SECTION,
            title: t("connections.core.trackers.title"),
            intro: t("connections.core.trackers.intro"),
            // Tasks' own words: the account layout does not hand them down.
            body: (
                <Messages namespaces={["tasks"]}>
                    <TrackersView trackers={trackers} />
                </Messages>
            )
        });
    sections.push({
        id: AI_KEYS_SECTION,
        title: t("aiKeys.page.title"),
        intro: t("aiKeys.page.intro"),
        body: <AiKeysPanel userId={user.id} />
    });
    return {
        ids: sections.map((section) => section.id),
        node: sections.map((section) => (
            <section
                key={section.id}
                id={`connection-${section.id}`}
                aria-labelledby={`connection-${section.id}-title`}
                className="flex scroll-mt-4 flex-col gap-2"
            >
                <div className="min-w-0">
                    <h2 id={`connection-${section.id}-title`} className="text-sm font-medium">
                        {section.title}
                    </h2>
                    <p className="text-sm text-muted-foreground">{section.intro}</p>
                </div>
                {section.body}
            </section>
        ))
    };
}
