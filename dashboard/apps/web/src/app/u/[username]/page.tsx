/**
 * Somebody's page, at an address that can be handed out: `/u/<username>`.
 *
 * Reachable by both kinds of reader, which is what makes it different from every
 * other screen here. A reader who is signed in gets Polaris - the bar, the app
 * switcher, the rail, their own account menu - because being sent a link to a
 * colleague is not a reason to be shown a different product; a reader who is not
 * gets the public bar, with a way in where the account menu would be. Which of
 * the two is ProfileFrame's decision, taken once for this page and the
 * organization's.
 *
 * Whether a signed-out reader is shown anything at all is the operator's call and
 * is off by default, and what any reader is shown is each account's own privacy
 * settings. Both live in `profile-service`; this page only draws the answer.
 */

import type { Metadata } from "next";
import { guardedUser } from "@/lib/session";
import { ProfileCard } from "./profile-card";
import { publicProfile, profilesArePublic } from "@/lib/profile-service";
import { NothingToShow, ProfileFrame } from "@/components/profile-frame";

export const dynamic = "force-dynamic";

/** Deliberately the same title whether or not the person exists: a page that
 *  named them in the tab before saying whether it would show them is a page that
 *  answers "does this username exist" to anybody who asks. */
export const metadata: Metadata = { title: "Profile - Polaris" };

export default async function ProfilePage({ params }: { params: Promise<{ username: string }> }) {
    const { username } = await params;
    // The session with its own gate applied. One that has not cleared it - locked,
    // waiting for approval - is not shown the application's navigation here, for
    // the same reason it is not shown it anywhere else, and reads this page as
    // anybody without an account would.
    const viewer = await guardedUser().catch(() => null);
    const profile = await publicProfile(
        decodeURIComponent(username),
        viewer ? { id: viewer.id, isAdmin: viewer.isAdmin } : null
    );

    if (!profile) {
        const closed = !viewer && !(await profilesArePublic());
        return (
            <ProfileFrame viewer={viewer}>
                <NothingToShow closed={closed} subject="profile" />
            </ProfileFrame>
        );
    }

    return (
        <ProfileFrame viewer={viewer}>
            <ProfileCard profile={profile} own={viewer?.id === profile.id} signedIn={viewer !== null} />
        </ProfileFrame>
    );
}
