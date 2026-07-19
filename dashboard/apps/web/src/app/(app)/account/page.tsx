/**
 * "My account" page (/account): lets the signed-in user manage their own profile
 * (name, username), email, and password. Server component that loads the current
 * user's editable fields and hands them to the client view.
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
                <h1 className="text-lg font-semibold">My account</h1>
                <p className="text-sm text-muted-foreground">Update your profile, email, and password.</p>
            </div>
            <AccountView
                name={user?.name ?? session.name}
                email={user?.email ?? session.email}
                username={user?.username ?? ""}
            />
        </div>
    );
}
