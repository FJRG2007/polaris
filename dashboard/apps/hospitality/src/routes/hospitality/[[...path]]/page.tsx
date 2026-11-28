/**
 * Hospitality: `/hospitality` is service (the floor and its orders) and
 * `/hospitality/kitchen` the kitchen display, `/hospitality/till` the till and
 * `/hospitality/menu` the menu, `/hospitality/devices` the linked devices. The server hands over the frame and nothing
 * else; the screens read their data in the browser, so the tabs are on screen
 * before any request has left.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { host } from "@polaris/app-host";
import { hospitalityT } from "../../../lib/i18n";
import { HospitalityScreen } from "../../../screens/menu-screen";
import { ServiceScreen } from "../../../screens/service-screen";
import { KitchenScreen } from "../../../screens/kitchen-screen";
import { TillScreen } from "../../../screens/till-screen";
import { DevicesScreen } from "../../../screens/devices-screen";
import { DegradedBanner } from "../../../screens/connection";

export const dynamic = "force-dynamic";

const TABS = [
    { path: "", key: "tabs.service" },
    { path: "kitchen", key: "tabs.kitchen" },
    { path: "till", key: "tabs.till" },
    { path: "menu", key: "tabs.menu" },
    { path: "devices", key: "tabs.devices" }
] as const;

/** Tabs only a manager is offered at all. */
const MANAGER_ONLY: ReadonlySet<string> = new Set(["till", "devices"]);

export default async function HospitalityPage({ params }: { params: Promise<Record<string, string | string[]>> }) {
    const [user, raw, t] = await Promise.all([
        host.session.requirePermission("hospitality.use"),
        params.then((all) => all.path),
        hospitalityT()
    ]);
    const path = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const tab = path[0] ?? "";
    if (path.length > 1 || !TABS.some((x) => x.path === tab)) notFound();
    const manager = await host.session.sessionCan(user, "hospitality.manage");
    // The till is a manager's: a waiter is not offered the tab at all.
    if (MANAGER_ONLY.has(tab) && !manager) notFound();
    return (
        <div className="flex min-h-0 min-w-0 flex-col">
            <nav className="flex min-w-0 gap-1 overflow-x-auto border-b px-3 py-1.5" aria-label={t("tabs.label")}>
                {TABS.filter((x) => manager || !MANAGER_ONLY.has(x.path)).map((x) => (
                    <Link
                        key={x.path}
                        href={x.path ? `/hospitality/${x.path}` : "/hospitality"}
                        aria-current={x.path === tab ? "page" : undefined}
                        className={
                            x.path === tab
                                ? "rounded-md bg-muted px-3 py-1.5 text-sm font-medium"
                                : "rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted"
                        }
                    >
                        {t(x.key)}
                    </Link>
                ))}
            </nav>
            <DegradedBanner />
            {tab === "menu" ? (
                <HospitalityScreen manager={manager} />
            ) : tab === "kitchen" ? (
                <KitchenScreen />
            ) : tab === "till" ? (
                <TillScreen manager={manager} />
            ) : tab === "devices" ? (
                <DevicesScreen />
            ) : (
                <ServiceScreen manager={manager} />
            )}
        </div>
    );
}
