/**
 * Profile page (/account): what everybody else sees - the pictures, the display
 * name and handle, the paragraph, the appearance, and where the person says they
 * work.
 *
 * The account behind it - the name held on the account, the addresses that sign
 * in, the phone number - is next door at /account/details. The split is between
 * publishing and plumbing: every field here is a decision about what a colleague
 * sees, and every field there is a decision about how Polaris reaches you. They
 * were one form, which meant the consequence of a field changed halfway down it
 * with nothing but a line of grey text to say so.
 *
 * This page keeps the address it always had, so the "your profile" links across
 * the product - the one on the public page, the one after confirming an email -
 * still land where they say they do, and no redirect had to be invented for a
 * screen that never moved. Credentials, sessions, network rules and API keys
 * each have their own page under the same section.
 *
 * Server component that loads the editable fields and hands them to the client
 * views.
 */

import { prisma } from "@polaris/db";
import { AppearanceCard } from "./appearance-card";
import { requireUser } from "@/lib/session";
import { ProfileView } from "./profile-view";
import { CompaniesCard } from "./companies-card";
import { DetailsCard } from "./details-card";
import {
    organizationsOf,
    profileLinks,
    shownOrganizations,
    typedCompanies
} from "@/lib/profile-service";
import { getSetting } from "@/lib/setting-store";
import { getProfileStyle } from "@/lib/profile-style-service";
import {
    usernameChangeAllowedAt,
    usernameCooldownDays,
    usernameCooldownRemaining,
    USERNAME_COOLDOWN_KEY
} from "@polaris/core";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
    const session = await requireUser();
    const [user, photo, banner, style, organizations, shown] = await Promise.all([
        prisma.user.findUnique({
            where: { id: session.id },
            select: {
                name: true,
                firstName: true,
                lastName: true,
                username: true,
                usernameChangedAt: true,
                company: true,
                profileCompanies: true,
                description: true,
                headline: true,
                pronouns: true,
                links: true
            }
        }),
        // Only whether there is one to replace or remove; the picture itself is
        // fetched by the browser like every other face on the page.
        prisma.userAvatar.findUnique({ where: { userId: session.id }, select: { userId: true } }),
        // The same, for the band across the top of the profile.
        prisma.userBanner.findUnique({ where: { userId: session.id }, select: { userId: true } }),
        // What they chose their profile to look like, so the panel opens on what
        // is already true rather than on nothing and then correcting itself.
        getProfileStyle(session.id),
        // Where they work: the organizations here they could show, and the ones
        // they have. Both read from one place, so the list somebody picks from
        // and the list their page publishes cannot drift.
        organizationsOf(session.id),
        shownOrganizations(session.id)
    ]);

    // How long until this account may take a different handle, as a phrase the
    // field can print. Undefined when it may now, which is what leaves the field
    // open. Worked out here rather than in the browser so the server and the
    // client cannot disagree about what the clock says.
    const now = new Date();
    const allowedAt = usernameChangeAllowedAt(
        user?.usernameChangedAt ?? null,
        usernameCooldownDays(await getSetting(USERNAME_COOLDOWN_KEY))
    );
    const usernameChangeIn =
        allowedAt && allowedAt.getTime() > now.getTime()
            ? usernameCooldownRemaining(allowedAt, now)
            : undefined;

    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">Profile</h1>
                <p className="text-sm text-muted-foreground">
                    How you appear to everybody else in Polaris.
                </p>
            </div>
            <ProfileView
                name={user?.name ?? session.name}
                // Not edited here - the account screen owns them - but the handle
                // field builds its suggestions out of what somebody is called,
                // and suggestions built out of nothing are worse.
                firstName={user?.firstName ?? ""}
                lastName={user?.lastName ?? ""}
                username={user?.username ?? ""}
                // How long until they may take a different handle, so the field
                // can say so before anybody types into it - finding out by being
                // refused is the version that wastes somebody's time.
                usernameChangeIn={usernameChangeIn}
                description={user?.description ?? ""}
            />
            {/* One card, not two. The picture handles live on the preview that
                was already drawing the same banner and the same face - having
                both was the profile shown twice on one screen. */}
            <AppearanceCard
                userId={session.id}
                name={user?.name ?? session.name}
                hasPhoto={photo !== null}
                hasBanner={banner !== null}
                initial={style}
            />
            <DetailsCard
                headline={user?.headline ?? ""}
                pronouns={user?.pronouns ?? ""}
                links={profileLinks(user?.links ?? null)}
            />
            <CompaniesCard
                companies={user ? typedCompanies(user) : []}
                organizations={organizations}
                shown={shown.map((org) => org.id)}
                username={user?.username ?? ""}
            />
        </div>
    );
}
