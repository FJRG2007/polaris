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
import { McpAssistants } from "./mcp-assistants";
import { ConnectedApps } from "./connected-apps";
import { resolveEnforcedRules, scopesAvailableTo } from "@polaris/auth";
import { editableScopes, mcpScopes } from "@/lib/mcp/oauth/scopes";
import { getTranslations } from "@/lib/i18n/request";
import { Messages } from "@/components/i18n/messages";
import { rulesAreEmpty } from "@/lib/network-rules";
import { listConnectedApps } from "@/lib/mcp/oauth/grants";
import type { DatabaseOption } from "./database-reach-picker";
import { Card, CardBody, CardHeader, Skeleton } from "@polaris/ui";

export const dynamic = "force-dynamic";

/** The list, once the grants and what this person holds are read. */
async function ConnectedAppsSection({ userId, isAdmin }: { userId: string; isAdmin: boolean }) {
    const [apps, available, supported, enforced] = await Promise.all([
        listConnectedApps(userId),
        scopesAvailableTo(userId, isAdmin),
        mcpScopes(),
        resolveEnforcedRules(userId)
    ]);
    // What each app could be given: what MCP offers now and the old scopes it
    // still holds, cut to what this person holds. The ones it did not ask for
    // are marked. The action cuts it the same way again.
    const rows = apps.map((app) => {
        const requestable = new Set(app.requestable);
        const offered = editableScopes(app.scopes, supported, available);
        const unrequested = offered.filter((scope) => !requestable.has(scope));
        return { ...app, offered, unrequested };
    });
    // The databases an app may be pointed at, read only when some app holds a
    // database permission: the list reaches the connection store.
    const databases = rows.some((app) => app.scopes.some((scope) => scope.startsWith("databases.")))
        ? await databaseOptions(userId)
        : [];
    // The rules a connected assistant is held to are the ones an administrator
    // imposed (the account's own sign-in rules govern sign-ins, not
    // assistants), so those are what decide whether the note is shown.
    return (
        <ConnectedApps
            apps={rows}
            restricted={!rulesAreEmpty(enforced)}
            canExcept={isAdmin}
            databases={databases}
        />
    );
}

/** The databases this person can open, as the picker lists them: names and
 *  engines, never an address. Empty when the list cannot be read - the
 *  dialog then has nothing to tick, and the server keeps what is held. */
async function databaseOptions(userId: string): Promise<DatabaseOption[]> {
    try {
        const { listOpenable } = await import("@/lib/data/connections");
        return (await listOpenable(userId)).map((entry) => ({
            id: entry.id,
            name: entry.name,
            engine: entry.engine,
            project: entry.origin === "managed" ? entry.where : null
        }));
    } catch (error) {
        console.error("assistants: the databases could not be listed", error);
        return [];
    }
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
