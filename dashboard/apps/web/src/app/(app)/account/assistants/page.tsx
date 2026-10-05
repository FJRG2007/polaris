/**
 * AI assistants (/account/assistants): the assistants connected to this
 * account over MCP, what each may do, and how to connect another.
 *
 * Its own screen rather than a card under API keys: an assistant is connected
 * by signing in from it, not by making a key, and that is not where anybody
 * looks for it. The heading and the setup steps are drawn at once; only the
 * list waits on the database.
 */

import { Suspense } from "react";
import { requireUser } from "@/lib/session";
import type { Permission } from "@polaris/core";
import { McpAssistants } from "./mcp-assistants";
import { ConnectedApps } from "./connected-apps";
import { scopesAvailableTo } from "@polaris/auth";
import { mcpScopes } from "@/lib/mcp/oauth/scopes";
import { getTranslations } from "@/lib/i18n/request";
import { Messages } from "@/components/i18n/messages";
import { listConnectedApps } from "@/lib/mcp/oauth/grants";
import { Card, CardBody, CardHeader, Skeleton } from "@polaris/ui";

export const dynamic = "force-dynamic";

/** The list, once the grants and what this person holds are read. */
async function ConnectedAppsSection({ userId, isAdmin }: { userId: string; isAdmin: boolean }) {
    const [apps, available] = await Promise.all([
        listConnectedApps(userId),
        scopesAvailableTo(userId, isAdmin)
    ]);
    const held = new Set<string>(available);
    // What each app could be given: what it asked for, cut to what MCP offers
    // and what this person holds. The action cuts it the same way again.
    const supported = mcpScopes();
    const rows = apps.map((app) => {
        const requestable = new Set(app.requestable);
        const offered: Permission[] = supported.filter(
            (scope) => requestable.has(scope) && held.has(scope)
        );
        return { ...app, offered };
    });
    return <ConnectedApps apps={rows} />;
}

/** The shape of the list while it is read. */
function ConnectedAppsSkeleton({ label }: { label: string }) {
    return (
        <Card aria-busy="true" aria-label={label}>
            <CardHeader>
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-full max-w-sm" />
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                {[0, 1].map((row) => (
                    <div key={row} className="flex items-start gap-3">
                        <Skeleton className="size-9 rounded-lg" />
                        <div className="flex flex-1 flex-col gap-1.5">
                            <Skeleton className="h-3.5 w-32" />
                            <Skeleton className="h-3 w-48 max-w-full" />
                            <Skeleton className="h-3 w-24" />
                        </div>
                    </div>
                ))}
            </CardBody>
        </Card>
    );
}

export default async function AssistantsPage() {
    const user = await requireUser();
    const t = await getTranslations("mcp");

    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("page.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("page.intro")}</p>
            </div>
            <Messages namespaces={["mcp"]}>
                <Suspense fallback={<ConnectedAppsSkeleton label={t("connectedApps.loading")} />}>
                    <ConnectedAppsSection userId={user.id} isAdmin={user.isAdmin} />
                </Suspense>
            </Messages>
            <div id="connect" className="scroll-mt-4">
                <McpAssistants />
            </div>
        </div>
    );
}
