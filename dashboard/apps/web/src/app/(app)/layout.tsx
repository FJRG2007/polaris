import type { ReactNode } from "react";
import { getCapabilities } from "@polaris/config";
import { AppShell, CapabilityProvider, EditionBadge } from "@polaris/ui";
import { AccountMenu } from "@/components/account-menu";
import { AppNav } from "@/components/app-nav";
import { requireUser } from "@/lib/session";

/**
 * Authenticated dashboard chrome. Resolves the session server-side (redirecting
 * to sign-in if absent) and hands the current capability snapshot to the client
 * provider so features degrade correctly for the running edition.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
    const user = await requireUser();
    const capabilities = getCapabilities();

    return (
        <CapabilityProvider capabilities={capabilities}>
            <AppShell
                switcher={<AppNav />}
                account={
                    <>
                        <EditionBadge />
                        <AccountMenu name={user.name} email={user.email} isAdmin={user.isAdmin} />
                    </>
                }
            >
                {children}
            </AppShell>
        </CapabilityProvider>
    );
}
