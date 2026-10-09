/**
 * Somebody's page, followed from inside Polaris.
 *
 * The address is `/u/<username>`, which lives outside the application's layout
 * because a signed-out reader can be handed it too. Following a link to it from
 * a screen in here would therefore swap one layout for the other, and the call
 * this tab is in - held by the application's layout - would be torn down on the
 * way. Intercepting the navigation draws the same page inside this layout
 * instead, so the call carries on. A reload, or the address opened directly,
 * still reaches the page itself.
 */

import type { Metadata } from "next";
import { guardedUser } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { ProfileBody } from "@/app/u/[username]/profile-body";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
    return { title: (await getTranslations("publicPages"))("profile.metaTitle") };
}

export default async function ProfileInApp({ params }: { params: Promise<{ username: string }> }) {
    const { username } = await params;
    const viewer = await guardedUser().catch(() => null);
    return (
        // The measure ProfileFrame gives the same card.
        <div className="mx-auto w-full max-w-2xl">
            <ProfileBody username={username} viewer={viewer} />
        </div>
    );
}
