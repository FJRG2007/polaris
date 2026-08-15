/**
 * One pull request or issue.
 *
 * The path carries the repository and the number and nothing else - which is a
 * request, not a grant. GitHub answers 404 to a token that cannot see it, and
 * that is exactly the right answer: this screen never learns whether something
 * it cannot open exists.
 */

import { requirePermission } from "@/lib/session";
import { WorkDetail } from "@/app/(app)/apps/code/work-detail";

export const dynamic = "force-dynamic";

export default async function CodeItemPage({
    params
}: {
    params: Promise<{ owner: string; repo: string; number: string }>;
}) {
    await requirePermission("agents.read");
    const { owner, repo, number } = await params;

    return <WorkDetail owner={owner} repo={repo} number={Number(number)} />;
}
