/**
 * What an organization's page shows, without the frame around it - drawn by
 * `/o/<slug>` and by the same address followed from inside Polaris, for the
 * reason `u/[username]/profile-body` gives.
 */

import type { SessionUser } from "@/lib/session";
import { OrgProfileCard } from "./org-profile-card";
import { Messages } from "@/components/i18n/messages";
import { NothingToShow } from "@/components/nothing-to-show";
import { orgProfile, profilesArePublic } from "@/lib/profile-service";

export async function OrgBody({ slug, viewer }: { slug: string; viewer: SessionUser | null }) {
    const org = await orgProfile(
        decodeURIComponent(slug),
        viewer ? { id: viewer.id, isAdmin: viewer.isAdmin } : null
    );

    if (!org) {
        const closed = !viewer && !(await profilesArePublic());
        return <NothingToShow closed={closed} subject="organization" />;
    }

    return (
        <Messages namespaces={["publicPages"]}>
            <OrgProfileCard org={org} />
        </Messages>
    );
}
