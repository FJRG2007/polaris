/**
 * Code (/apps/code): the pull requests and issues waiting on somebody.
 *
 * Nothing is fetched on the server. The list is a live GitHub read scoped to
 * whoever is asking, and holding the navigation while a third party answers
 * would put a stranger's latency between somebody and their own dashboard - so
 * the page ships the frame and the filters at once and the rows arrive into it.
 */

import { CodeView } from "./code-view";
import { PageHeader } from "@polaris/ui";
import { requirePermission } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function CodePage() {
    await requirePermission("agents.read");

    return (
        <>
            <PageHeader
                title="Code"
                description="Pull requests and issues across the GitHub accounts you have linked."
            />
            <CodeView />
        </>
    );
}
