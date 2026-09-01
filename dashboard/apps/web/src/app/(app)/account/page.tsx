/**
 * Profile page (/account): the signed-in user's own name, username, company, and
 * the ways they can be reached - the address that signs in, any alternates, and
 * the phone number. Credentials, sessions, network rules, and API keys each have
 * their own page under the same section. Server component that loads the
 * editable fields and hands them to the client view.
 */

import { prisma } from "@polaris/db";
import { ProfilePicturesCard } from "./avatar-card";
import { requireUser } from "@/lib/session";
import { AccountView } from "./account-view";
import { getSetting } from "@/lib/setting-store";
import { getAuthMailStatus } from "@/lib/auth-mail";
import {
    usernameChangeAllowedAt,
    usernameCooldownDays,
    usernameCooldownRemaining,
    USERNAME_COOLDOWN_KEY
} from "@polaris/core";
import { getUserPhone, listUserEmails } from "@polaris/auth";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
    const session = await requireUser();
    const [user, photo, banner, emails, mail, phone, whatsappChannel] = await Promise.all([
        prisma.user.findUnique({
            where: { id: session.id },
            select: {
                name: true,
                firstName: true,
                lastName: true,
                username: true,
                usernameChangedAt: true,
                company: true,
                description: true
            }
        }),
        // Only whether there is one to replace or remove; the picture itself is
        // fetched by the browser like every other face on the page.
        prisma.userAvatar.findUnique({ where: { userId: session.id }, select: { userId: true } }),
        // The same, for the band across the top of the profile.
        prisma.userBanner.findUnique({ where: { userId: session.id }, select: { userId: true } }),
        listUserEmails(session.id),
        getAuthMailStatus(),
        getUserPhone(session.id),
        // Confirming a number is sent the same way a sign-in code is, so the card
        // needs to know whether there is anything to send with.
        prisma.channel.findFirst({
            where: { ownerId: session.id, platform: "whatsapp", status: "connected" },
            select: { id: true }
        })
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
                <p className="text-sm text-muted-foreground">How you appear in Polaris, and how you sign in.</p>
            </div>
            <ProfilePicturesCard
                userId={session.id}
                name={user?.name ?? session.name}
                hasPhoto={photo !== null}
                hasBanner={banner !== null}
            />
            <AccountView
                name={user?.name ?? session.name}
                firstName={user?.firstName ?? ""}
                lastName={user?.lastName ?? ""}
                username={user?.username ?? ""}
                // How long until they may take a different handle, so the field
                // can say so before anybody types into it - finding out by being
                // refused is the version that wastes somebody's time.
                usernameChangeIn={usernameChangeIn}
                company={user?.company ?? ""}
                description={user?.description ?? ""}
                emails={emails}
                mailReady={mail.channelId !== null}
                phone={phone}
                canSendWhatsApp={whatsappChannel !== null}
            />
        </div>
    );
}
