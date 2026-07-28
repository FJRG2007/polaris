/**
 * Profile page (/account): the signed-in user's own name, username, and email.
 * Credentials, sessions, network rules, and API keys each have their own page
 * under the same section. Server component that loads the editable fields and
 * hands them to the client view.
 */

import { prisma } from "@polaris/db";
import { requireUser } from "@/lib/session";
import { AccountView } from "./account-view";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
    const session = await requireUser();
    const user = await prisma.user.findUnique({
        where: { id: session.id },
        select: { name: true, email: true, username: true }
    });

    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-lg font-semibold">Profile</h1>
                <p className="text-sm text-muted-foreground">How you appear in Polaris, and how you sign in.</p>
            </div>
            <AccountView
                name={user?.name ?? session.name}
                email={user?.email ?? session.email}
                username={user?.username ?? ""}
            />
        </div>
    );
}
