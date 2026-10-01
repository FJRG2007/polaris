/**
 * A participant's vote on a meeting proposal, from the link they were sent. No
 * session: the token is the whole of the right to vote for that one person.
 */

import { notFound } from "next/navigation";
import { votePage } from "../../../../lib/proposals";
import { VoteForm } from "../../../../screens/public/vote-form";

export const dynamic = "force-dynamic";

export default async function VotePage({
    params
}: {
    params: Promise<Record<string, string | string[]>>;
}) {
    const { token } = await params;
    if (typeof token !== "string") notFound();
    const view = await votePage(token);
    if (!view) notFound();
    return <VoteForm token={token} view={view} />;
}
