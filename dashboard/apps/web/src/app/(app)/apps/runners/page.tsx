import Link from "next/link";
import { Suspense } from "react";
import { Notice } from "./notice";
import { PageHeader } from "@polaris/ui";
import { RunnersView } from "./runners-view";
import { LOCAL_SERVER_ID } from "@polaris/core";
import { requirePermission } from "@/lib/session";
import { getRunnerAccess } from "@/lib/github-runners";
import { listRunnerPools } from "@/lib/runners/runner-service";
import { localMachineIdentity } from "@/lib/local-machine";
import { findLocalHost, hasOtherServer } from "@/lib/server-options";
import { getLocalServerName, LOCAL_SERVER_FALLBACK_NAME } from "@/lib/local-server";
import { getTranslations } from "@/lib/i18n/request";
import { runnerText } from "@/lib/runners/words";

export const dynamic = "force-dynamic";

/**
 * Pools and servers come from the database, so the page is on screen at once.
 * Whether the GitHub connection may register runners is two calls to GitHub, and
 * it only decides a notice - so it is streamed in behind a Suspense boundary
 * rather than held in front of the whole screen.
 */
export default async function RunnersPage() {
    const user = await requirePermission("system.manage");
    const t = await getTranslations("runners");
    const [pools, localName, identity] = await Promise.all([
        listRunnerPools(user.id),
        getLocalServerName(),
        localMachineIdentity()
    ]);

    // The box Polaris runs on is always available to run jobs on, the same way it
    // is always an option in Deploy. Which id it is offered under decides what it
    // can be asked to do: enrolled, it is a Host with a login, so a job can be
    // given a directory on it; unenrolled, Polaris reaches it only through the
    // container engine and it runs contained jobs or none.
    const localHost = await findLocalHost(user.id, identity);
    const local = {
        id: localHost?.id ?? LOCAL_SERVER_ID,
        name: localName || localHost?.name || LOCAL_SERVER_FALLBACK_NAME,
        // Nothing to pick besides it: the form picks this machine for the operator.
        alone: !(await hasOtherServer(user.id, localHost?.id ?? null))
    };

    return (
        <>
            <PageHeader title={t("page.title")} description={t("page.description")} />
            <RunnersView
                pools={pools}
                local={local}
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
    const t = await getTranslations("runners");
    return (
        <Notice>
            {access?.advice ? runnerText(t, access.advice) : t("page.connect")}{" "}
            <Link href="/admin/integrations" className="underline">
                {t("page.openIntegrations")}
            </Link>
        </Notice>
    );
}
