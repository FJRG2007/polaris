import Link from "next/link";
import { Suspense } from "react";
import { Notice } from "./notice";
import { PageHeader } from "@polaris/ui";
import { RunnersView } from "./runners-view";
import { listHosts } from "@/lib/host-service";
import { LOCAL_SERVER_ID } from "@polaris/core";
import { requirePermission } from "@/lib/session";
import { getRunnerAccess } from "@/lib/github-runners";
import { listRunnerPools } from "@/lib/runners/runner-service";
import { getLocalServerName, LOCAL_SERVER_FALLBACK_NAME } from "@/lib/local-server";

export const dynamic = "force-dynamic";

/**
 * Pools and servers come from the database, so the page is on screen at once.
 * Whether the GitHub connection may register runners is two calls to GitHub, and
 * it only decides a notice - so it is streamed in behind a Suspense boundary
 * rather than held in front of the whole screen.
 */
export default async function RunnersPage() {
    const user = await requirePermission("system.manage");
    const [pools, hosts, localName] = await Promise.all([
        listRunnerPools(user.id),
        listHosts(user.id),
        getLocalServerName()
    ]);

    // The box Polaris runs on is always available to run jobs on, the same way it
    // is always an option in Deploy - it just runs them in containers only.
    const servers = [
        { id: LOCAL_SERVER_ID, name: localName || LOCAL_SERVER_FALLBACK_NAME, local: true },
        ...hosts.map((host) => ({ id: host.id, name: host.name, local: false }))
    ];

    return (
        <>
            <PageHeader
                title="Runners"
                description="Run GitHub Actions workflows on your own servers. Each job gets a runner that registers, takes that one job, and disappears."
            />
            <RunnersView
                pools={pools}
                servers={servers}
                accessNotice={
                    <Suspense fallback={null}>
                        <GithubAccess />
                    </Suspense>
                }
            />
        </>
    );
}

/** What the GitHub connection is missing, when it is missing something. Read here
 *  rather than in the form: the operator should learn a permission is absent
 *  before they fill anything in, and this is the same evaluation the GitHub card
 *  on Integrations shows. */
async function GithubAccess() {
    const access = await getRunnerAccess().catch(() => null);
    if (access?.ready) return null;
    return (
        <Notice>
            {access?.advice ?? "Connect GitHub before adding runners."}{" "}
            <Link href="/integrations" className="underline">
                Open Integrations
            </Link>
        </Notice>
    );
}
