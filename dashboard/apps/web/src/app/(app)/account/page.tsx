/**
 * Profile page (/account): the signed-in user's own name, username, and the
 * addresses on the account - the one that signs in, plus any alternates.
 * Credentials, sessions, network rules, and API keys each have their own page
 * under the same section. Server component that loads the editable fields and
 * hands them to the client view.
 */

import { listUserEmails } from "@polaris/auth";
import { prisma } from "@polaris/db";
import { requireUser } from "@/lib/session";
import { AccountView } from "./account-view";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
    const session = await requireUser();
    const [user, emails] = await Promise.all([
        prisma.user.findUnique({
            where: { id: session.id },
            select: { name: true, username: true }
        }),
        listUserEmails(session.id)
    ]);

    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-lg font-semibold">Profile</h1>
                <p className="text-sm text-muted-foreground">How you appear in Polaris, and how you sign in.</p>
            </div>
            <AccountView
                name={user?.name ?? session.name}
                username={user?.username ?? ""}
                emails={emails}
            />
        </div>
    );
}
