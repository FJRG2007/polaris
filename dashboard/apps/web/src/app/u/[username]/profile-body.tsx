/**
 * What a person's page shows, without the frame around it.
 *
 * Two routes draw it: the address itself, `/u/<username>`, which picks its frame
 * for whoever is reading, and the same address followed from inside Polaris,
 * which is drawn in the application's own layout so that opening somebody's page
 * does not take the call you are in down with it - see `(app)/(.)u/[username]`.
 */

import { ProfileCard } from "./profile-card";
import type { SessionUser } from "@/lib/session";
import { Messages } from "@/components/i18n/messages";
import { NothingToShow } from "@/components/nothing-to-show";
import { publicProfile, profilesArePublic } from "@/lib/profile-service";

export async function ProfileBody({ username, viewer }: { username: string; viewer: SessionUser | null }) {
    const profile = await publicProfile(
        decodeURIComponent(username),
        viewer ? { id: viewer.id, isAdmin: viewer.isAdmin } : null
    );

    if (!profile) {
        const closed = !viewer && !(await profilesArePublic());
        return <NothingToShow closed={closed} subject="profile" />;
    }

    return (
        <Messages namespaces={["publicPages"]}>
            <ProfileCard profile={profile} own={viewer?.id === profile.id} signedIn={viewer !== null} />
        </Messages>
    );
}
