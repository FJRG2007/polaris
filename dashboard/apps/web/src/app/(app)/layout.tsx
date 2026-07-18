import type { ReactNode } from "react";
import { getCapabilities } from "@polaris/config";
import { AppShell, AppSwitcher, CapabilityProvider, EditionBadge } from "@polaris/ui";
import { POLARIS_APPS } from "@/lib/apps";
import { AccountMenu } from "@/components/account-menu";
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
                switcher={<AppSwitcher apps={POLARIS_APPS} currentAppId="drive" />}
                account={
                    <>
                        <EditionBadge />
                        <AccountMenu name={user.name} email={user.email} />
                    </>
                }
            >
                {children}
            </AppShell>
        </CapabilityProvider>
    );
}
