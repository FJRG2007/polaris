/**
 * Somebody's page, at an address that can be handed out: `/u/<username>`.
 *
 * Outside the app's own chrome on purpose. This is the one screen in Polaris
 * whose whole point is to be opened by a person who is not already inside it -
 * pasted into a message, a signature, a CV - so it is drawn in the same frame
 * every other public link uses: the mark, a way in, and one card. Somebody who
 * is signed in gets a way back to Polaris rather than a second navigation.
 *
 * Whether a signed-out reader is shown anything at all is the operator's call
 * and is off by default, and what any reader is shown is each account's own
 * privacy settings. Both live in `profile-service`; this page only draws the
 * answer.
 */

import type { Metadata } from "next";
import { resolveSession } from "@/lib/session";
import { PublicShell } from "@/components/public-shell";
import { ProfileCard } from "./profile-card";
import { publicProfile, profilesArePublic } from "@/lib/profile-service";
import { Card, CardBody } from "@polaris/ui";

export const dynamic = "force-dynamic";

/** Deliberately the same title whether or not the person exists: a page that
 *  named them in the tab before saying whether it would show them is a page that
 *  answers "does this username exist" to anybody who asks. */
export const metadata: Metadata = { title: "Profile - Polaris" };

async function viewerFor(): Promise<{ id: string; isAdmin: boolean } | null> {
    const session = await resolveSession().catch(() => null);
    return session ? { id: session.id, isAdmin: session.isAdmin } : null;
}

export default async function ProfilePage({ params }: { params: Promise<{ username: string }> }) {
    const { username } = await params;
    const viewer = await viewerFor();
    const profile = await publicProfile(decodeURIComponent(username), viewer);

    if (!profile) {
        // One answer for every reason - no such account, one that keeps itself
        // out of being found, a block, or an instance that does not publish
        // profiles at all. Telling them apart tells somebody which it was.
        const closed = !viewer && !(await profilesArePublic());
        return (
            <PublicShell signedIn={viewer !== null}>
                <Card>
                    <CardBody className="flex flex-col gap-2 py-10 text-center">
                        <p className="text-sm font-medium">Nothing to show here</p>
                        <p className="text-muted-foreground mx-auto max-w-md text-sm">
                            {closed
                                ? "This Polaris does not show profiles to people who are not signed in."
                                : "There is no profile at this address, or it is not one you can see."}
                        </p>
                    </CardBody>
                </Card>
            </PublicShell>
        );
    }

    return (
        <PublicShell signedIn={viewer !== null}>
            <ProfileCard
                profile={profile}
                own={viewer?.id === profile.id}
                signedIn={viewer !== null}
            />
        </PublicShell>
    );
}
