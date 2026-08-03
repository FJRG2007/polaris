/**
 * Profile page (/account): the signed-in user's own name, username, company, and
 * the ways they can be reached - the address that signs in, any alternates, and
 * the phone number. Credentials, sessions, network rules, and API keys each have
 * their own page under the same section. Server component that loads the
 * editable fields and hands them to the client view.
 */

import { prisma } from "@polaris/db";
import { AvatarCard } from "./avatar-card";
import { requireUser } from "@/lib/session";
import { AccountView } from "./account-view";
import { getAuthMailStatus } from "@/lib/auth-mail";
import { getGithubUserAuth } from "@/lib/github-service";
import { getGithubIdentity } from "@/lib/github-identity";
import { getUserPhone, listUserEmails } from "@polaris/auth";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
    const session = await requireUser();
    const [user, photo, emails, mail, phone, whatsappChannel, identity, userAuth] = await Promise.all([
        prisma.user.findUnique({
            where: { id: session.id },
            select: { name: true, username: true, company: true }
        }),
        // Only whether there is one to replace or remove; the picture itself is
        // fetched by the browser like every other face on the page.
        prisma.userAvatar.findUnique({ where: { userId: session.id }, select: { userId: true } }),
        listUserEmails(session.id),
        getAuthMailStatus(),
        getUserPhone(session.id),
        // Confirming a number is sent the same way a sign-in code is, so the card
        // needs to know whether there is anything to send with.
        prisma.channel.findFirst({
            where: { ownerId: session.id, platform: "whatsapp", status: "connected" },
            select: { id: true }
        }),
        getGithubIdentity(session.id),
        // Linking needs the connection to hold an OAuth client, which only the App
        // method has. Asked here so the card offers it or explains itself.
        getGithubUserAuth()
    ]);

    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-lg font-semibold">Profile</h1>
                <p className="text-sm text-muted-foreground">How you appear in Polaris, and how you sign in.</p>
            </div>
            <AvatarCard userId={session.id} name={user?.name ?? session.name} hasPhoto={photo !== null} />
            <AccountView
                name={user?.name ?? session.name}
                username={user?.username ?? ""}
                company={user?.company ?? ""}
                emails={emails}
                mailReady={mail.channelId !== null}
                phone={phone}
                canSendWhatsApp={whatsappChannel !== null}
                github={{
                    login: identity?.login ?? null,
                    avatarUrl: identity?.avatarUrl ?? null,
                    canLink: userAuth !== null
                }}
            />
        </div>
    );
}
