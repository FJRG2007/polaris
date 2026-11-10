/**
 * Polar's settings (/polar/settings), as a page rather than a dialog over the
 * chat: what Polar remembers, the tools it may use grouped by the MCP server
 * they come from, the actions it runs without asking, the connectors that
 * bring more tools, what chats show, the extras around them (a suggested next
 * message, the model for titles and suggestions), how a failing call falls back
 * and where a coding tool's request lands, and what the person keeps.
 *
 * The connectors and the "Always allow" list lived at /account/polar-tools;
 * they are here now, beside the switches for the same tools, and that address
 * sends here.
 *
 * Polar's conversation list stays beside them, as on /polar.
 *
 * The shell and every client section render at once; only the two lists the
 * server reads stream in behind skeletons shaped like them.
 */

import Link from "next/link";
import { SectionFromHash } from "./section-from-hash";
import { settingsSection } from "@/lib/polar/settings-path";
import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { mcpTools } from "@/lib/mcp/catalog";
import { SettingsBack } from "./settings-back";
import { SettingsWithSidebar } from "./settings-sidebar";
import { Messages } from "@/components/i18n/messages";
import { polarAccessFor } from "@/lib/polar/access";
import { getTranslations } from "@/lib/i18n/request";
import { listGrants } from "@/lib/polar/tool-grants";
import { PolarConnectors } from "./polar-connectors";
import { PolarToolGrants } from "./polar-tool-grants";
import { PolarBrowserSites } from "./polar-browser-sites";
import { PolarRoutingSettings } from "./polar-routing";
import { Card, CardBody, PAGE_BLEED, Skeleton, cn } from "@polaris/ui";
import { homePathForUser, requireUser } from "@/lib/session";
import { listConnectorViews } from "@/lib/polar/connectors/store";
import { DisplaySettings } from "@/components/polar/polar-display";
import { PolarHelperSettings } from "@/components/polar/polar-helper-settings";
import { DataSettings, MemorySettings, PolarToolSettings } from "@/components/polar/polar-settings";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("polar");
    return { title: t("settings.title") };
}

/** The list, once the grants and the tool titles are read. */
async function GrantsSection({ userId }: { userId: string }) {
    const [grants, tools] = await Promise.all([listGrants(userId), mcpTools()]);
    const titles = new Map(tools.map((entry) => [entry.name, entry.title ?? entry.name]));
    return (
        <PolarToolGrants
            grants={grants.map((grant) => ({
                id: grant.id,
                tool: grant.tool,
                title: titles.get(grant.tool) ?? null,
                targetName: grant.target ? grant.targetName || grant.target : null,
                createdAt: grant.createdAt.toISOString()
            }))}
        />
    );
}

/** The connectors, once read; secrets never leave the server. */
async function ConnectorsSection({
    userId,
    returned
}: {
    userId: string;
    returned: "signed_in" | "failed" | null;
}) {
    return <PolarConnectors initial={await listConnectorViews(userId)} returned={returned} />;
}

function ListSkeleton() {
    return (
        <Card>
            <CardBody className="flex flex-col gap-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
            </CardBody>
        </Card>
    );
}

function one(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

export default async function PolarSettingsPage({
    searchParams
}: {
    searchParams: Promise<{ connector?: string | string[]; section?: string | string[] }>;
}) {
    const user = await requireUser();
    const access = await polarAccessFor(user.id);
    if (!access.use) redirect(await homePathForUser(user));
    const params = await searchParams;
    const raw = one(params.connector);
    const returned = raw === "signed_in" || raw === "failed" ? raw : null;
    const [t, account] = await Promise.all([getTranslations("polar"), getTranslations("account")]);
    const connectorsListed = access.connectors && !user.viewingAs;
    const sections = [
        { id: "memory", label: t("settings.memory.title") },
        { id: "tools", label: t("settings.tools.title") },
        ...(connectorsListed ? [{ id: "connectors", label: t("settings.nav.connectors") }] : []),
        { id: "permissions", label: t("settings.nav.permissions") },
        { id: "browser", label: t("settings.browserSites.title") },
        { id: "display", label: t("settings.display.title") },
        { id: "extras", label: t("settings.helper.title") },
        { id: "routing", label: t("routing.title") },
        { id: "data", label: t("settings.data.title") }
    ];
    const asked = one(params.section) ?? (returned ? "connectors" : null);
    const section = sections.find(({ id }) => id === asked)?.id ?? "memory";
    return (
        <div className={cn(PAGE_BLEED, "flex")}>
            <SettingsWithSidebar>
                <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-6">
                    <div className="flex min-w-0 flex-col gap-1">
                        <SettingsBack label={t("settings.back")} />
                        <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                            {t("settings.title")}
                        </h1>
                        <p className="text-sm text-muted-foreground">{t("settings.intro")}</p>
                        <nav
                            aria-label={t("settings.title")}
                            className="mt-2 flex flex-wrap gap-1 border-b border-border pb-2"
                        >
                            {sections.map((entry) => (
                                <Link
                                    key={entry.id}
                                    href={settingsSection(entry.id)}
                                    aria-current={entry.id === section ? "page" : undefined}
                                    className={cn(
                                        "whitespace-nowrap rounded-md px-2.5 py-1 text-[13px] hover:bg-card hover:text-foreground",
                                        entry.id === section
                                            ? "bg-card text-foreground"
                                            : "text-muted-foreground"
                                    )}
                                >
                                    {entry.label}
                                </Link>
                            ))}
                        </nav>
                    </div>
                    <SectionFromHash ids={sections.map(({ id }) => id)} />
                    {section === "memory" ? <MemorySettings /> : null}
                    {section === "tools" ? (
                        <PolarToolSettings connectorsListed={connectorsListed} />
                    ) : null}
                    {section === "permissions" ? (
                        <section className="flex flex-col gap-2">
                            <div className="min-w-0">
                                <h2 className="text-sm font-medium text-foreground">
                                    {account("polarTools.title")}
                                </h2>
                                <p className="text-xs text-muted-foreground">
                                    {account("polarTools.intro")}
                                </p>
                                <p className="text-xs text-foreground-subtle">
                                    {account("polarTools.stillChecked")}
                                </p>
                            </div>
                            {/* The two lists moved here from the account pages and still
                                read their words from there. */}
                            <Messages namespaces={["account"]}>
                                <Suspense fallback={<ListSkeleton />}>
                                    <GrantsSection userId={user.id} />
                                </Suspense>
                            </Messages>
                        </section>
                    ) : null}
                    {section === "browser" ? (
                        <section className="flex flex-col gap-2">
                            <div className="min-w-0">
                                <h2 className="text-sm font-medium text-foreground">
                                    {t("settings.browserSites.title")}
                                </h2>
                                <p className="text-xs text-muted-foreground">
                                    {t("settings.browserSites.intro")}
                                </p>
                            </div>
                            <PolarBrowserSites />
                        </section>
                    ) : null}
                    {section === "connectors" ? (
                        <Messages namespaces={["account"]}>
                            <Suspense fallback={<ListSkeleton />}>
                                <ConnectorsSection userId={user.id} returned={returned} />
                            </Suspense>
                        </Messages>
                    ) : null}
                    {section === "display" ? <DisplaySettings /> : null}
                    {section === "extras" ? <PolarHelperSettings /> : null}
                    {section === "routing" ? <PolarRoutingSettings /> : null}
                    {section === "data" ? <DataSettings /> : null}
                </div>
            </SettingsWithSidebar>
        </div>
    );
}
