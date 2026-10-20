/**
 * Polar permissions (/account/polar-tools): the actions Polar runs without
 * asking first, each with Revoke. Added from "Always allow" on Polar's
 * approval card; nothing here widens what a tool may reach. Below them, the
 * MCP servers this person connected, when the deployment lets them.
 */

import { Suspense } from "react";
import { redirect } from "next/navigation";
import { Card, CardBody, Skeleton } from "@polaris/ui";
import { homePathForUser, requireUser } from "@/lib/session";
import { polarAccessFor } from "@/lib/polar/access";
import { getTranslations } from "@/lib/i18n/request";
import { mcpTools } from "@/lib/mcp/catalog";
import { listGrants } from "@/lib/polar/tool-grants";
import { PolarToolGrants } from "./polar-tool-grants";
import { PolarConnectors } from "./polar-connectors";
import { listConnectorViews } from "@/lib/polar/connectors/store";

export const dynamic = "force-dynamic";

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

export default async function PolarToolsPage({
    searchParams
}: {
    searchParams: Promise<{ connector?: string | string[] }>;
}) {
    const user = await requireUser();
    const access = await polarAccessFor(user.id);
    if (!access.use) redirect(await homePathForUser(user));
    const raw = (await searchParams).connector;
    const returned = raw === "signed_in" || raw === "failed" ? raw : null;
    const t = await getTranslations("account");
    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                    {t("polarTools.title")}
                </h1>
                <p className="text-sm text-muted-foreground">{t("polarTools.intro")}</p>
                <p className="text-xs text-foreground-subtle">{t("polarTools.stillChecked")}</p>
            </div>
            <Suspense
                fallback={
                    <Card>
                        <CardBody className="flex flex-col gap-2">
                            <Skeleton className="h-10 w-full" />
                            <Skeleton className="h-10 w-full" />
                        </CardBody>
                    </Card>
                }
            >
                <GrantsSection userId={user.id} />
            </Suspense>
            {access.connectors && !user.viewingAs ? (
                <Suspense
                    fallback={
                        <Card>
                            <CardBody className="flex flex-col gap-2">
                                <Skeleton className="h-12 w-full" />
                                <Skeleton className="h-12 w-full" />
                            </CardBody>
                        </Card>
                    }
                >
                    <ConnectorsSection userId={user.id} returned={returned} />
                </Suspense>
            ) : null}
        </div>
    );
}
