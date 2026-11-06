/**
 * Every screen of the VPN (/vpn and its sections).
 *
 * A marketplace app: until it is installed every section offers the install to
 * an administrator and says who can install it to anybody else. Somebody the VPN
 * was not given to sees that, and nothing of it: the app switcher does not list
 * it for them either (`accessFor` in `lib/session.ts`). Everything that
 * waits on the control server is asked for after the first paint, by the
 * section that shows it.
 */

import type { ReactNode } from "react";
import { PageHeader } from "@polaris/ui";
import { requireUser } from "@/lib/session";
import { vpnInstalled } from "@/lib/vpn/service";
import { VpnInstallState } from "./install-state";
import { VpnNoAccess } from "./no-access";
import { accessOf } from "@/lib/vpn/wireguard-service";
import { getTranslations } from "@/lib/i18n/request";
import { Messages } from "@/components/i18n/messages";

export const dynamic = "force-dynamic";

export default async function VpnLayout({ children }: { children: ReactNode }) {
    const user = await requireUser();
    const [t, installed, access] = await Promise.all([
        getTranslations("vpn"),
        vpnInstalled(),
        accessOf(user)
    ]);
    return (
        <Messages namespaces={["vpn"]}>
            <div className="mx-auto flex w-full max-w-5xl flex-col">
                <PageHeader title={t("page.title")} description={t("page.description")} />
                {!installed ? (
                    <VpnInstallState canInstall={user.isAdmin} />
                ) : access ? (
                    children
                ) : (
                    <VpnNoAccess withDevices={false} />
                )}
            </div>
        </Messages>
    );
}
