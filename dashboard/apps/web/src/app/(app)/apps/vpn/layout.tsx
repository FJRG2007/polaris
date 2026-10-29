/**
 * Every screen of the VPN (/apps/vpn and its sections).
 *
 * A marketplace app: until it is installed every section offers the install to
 * an administrator and says who can install it to anybody else. Everything that
 * waits on the control server is asked for after the first paint, by the
 * section that shows it.
 */

import type { ReactNode } from "react";
import { PageHeader } from "@polaris/ui";
import { requireUser } from "@/lib/session";
import { vpnInstalled } from "@/lib/vpn/service";
import { VpnInstallState } from "./install-state";
import { getTranslations } from "@/lib/i18n/request";
import { Messages } from "@/components/i18n/messages";

export const dynamic = "force-dynamic";

export default async function VpnLayout({ children }: { children: ReactNode }) {
    const user = await requireUser();
    const [t, installed] = await Promise.all([getTranslations("vpn"), vpnInstalled()]);
    return (
        <Messages namespaces={["vpn"]}>
            <div className="mx-auto flex w-full max-w-5xl flex-col">
                <PageHeader title={t("page.title")} description={t("page.description")} />
                {installed ? children : <VpnInstallState canInstall={user.isAdmin} />}
            </div>
        </Messages>
    );
}
