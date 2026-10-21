/**
 * Polar's settings (/polar/settings), as a page rather than a dialog over the
 * chat: what Polar remembers, the tools it may use grouped by the MCP server
 * they come from, the actions it runs without asking, the connectors that
 * bring more tools, what chats show, and what the person keeps.
 *
 * The connectors and the "Always allow" list lived at /account/polar-tools;
 * they are here now, beside the switches for the same tools, and that address
 * sends here.
 *
 * The shell and every client section render at once; only the two lists the
 * server reads stream in behind skeletons shaped like them.
 */

import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { mcpTools } from "@/lib/mcp/catalog";
import { SettingsBack } from "./settings-back";
import { Messages } from "@/components/i18n/messages";
import { polarAccessFor } from "@/lib/polar/access";
import { getTranslations } from "@/lib/i18n/request";
import { listGrants } from "@/lib/polar/tool-grants";
import { PolarConnectors } from "./polar-connectors";
import { PolarToolGrants } from "./polar-tool-grants";
import { Card, CardBody, Skeleton } from "@polaris/ui";
import { homePathForUser, requireUser } from "@/lib/session";
import { listConnectorViews } from "@/lib/polar/connectors/store";
import { DisplaySettings } from "@/components/polar/polar-display";
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

export default async function PolarSettingsPage({
    searchParams
}: {
    searchParams: Promise<{ connector?: string | string[] }>;
}) {
    const user = await requireUser();
    const access = await polarAccessFor(user.id);
    if (!access.use) redirect(await homePathForUser(user));
    const raw = (await searchParams).connector;
    const returned = raw === "signed_in" || raw === "failed" ? raw : null;
    const [t, account] = await Promise.all([getTranslations("polar"), getTranslations("account")]);
    const sections = [
        { id: "memory", label: t("settings.memory.title") },
        { id: "tools", label: t("settings.tools.title") },
        { id: "permissions", label: t("settings.nav.permissions") },
        { id: "display", label: t("settings.display.title") },
        { id: "data", label: t("settings.data.title") }
    ];
    return (
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
                    {sections.map((section) => (
                        <a
                            key={section.id}
                            href={`#${section.id}`}
                            className="whitespace-nowrap rounded-md px-2.5 py-1 text-[13px] text-muted-foreground hover:bg-card hover:text-foreground"
                        >
                            {section.label}
                        </a>
                    ))}
                </nav>
            </div>
            <div id="memory" className="scroll-mt-4">
                <MemorySettings />
            </div>
            <div id="tools" className="scroll-mt-4">
                <PolarToolSettings />
            </div>
            <section id="permissions" className="flex scroll-mt-4 flex-col gap-2">
                <div className="min-w-0">
                    <h2 className="text-sm font-medium text-foreground">
                        {account("polarTools.title")}
                    </h2>
                    <p className="text-xs text-muted-foreground">{account("polarTools.intro")}</p>
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
            {access.connectors && !user.viewingAs ? (
                <div id="connectors" className="scroll-mt-4">
                    <Messages namespaces={["account"]}>
                        <Suspense fallback={<ListSkeleton />}>
                            <ConnectorsSection userId={user.id} returned={returned} />
                        </Suspense>
                    </Messages>
                </div>
            ) : null}
            <div id="display" className="scroll-mt-4">
                <DisplaySettings />
            </div>
            <div id="data" className="scroll-mt-4">
                <DataSettings />
            </div>
        </div>
    );
}
