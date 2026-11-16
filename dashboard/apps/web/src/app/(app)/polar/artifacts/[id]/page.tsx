/**
 * One file a Polar Code session delivered, for somebody it was shared with on
 * its own (`agents.artifact`) or anybody who may read its session.
 */

import { notFound } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { mayReadArtifact } from "@/lib/agents/session-artifacts";
import { Messages } from "@/components/i18n/messages";
import { OwnArtifact } from "@/components/agents/sessions/session-artifacts";

export const dynamic = "force-dynamic";

export default async function ArtifactPage({ params }: { params: Promise<{ id: string }> }) {
    const id = z.string().uuid().safeParse((await params).id);
    if (!id.success) notFound();
    const user = await requireUser();
    if (!(await mayReadArtifact(user.id, id.data))) notFound();
    return (
        <Messages namespaces={["polar", "agents"]}>
            <div className="h-[calc(100dvh-var(--header-height,4rem)-var(--notice-height,0px)-3rem)] min-h-96 overflow-hidden rounded-md border border-border">
                <OwnArtifact artifactId={id.data} />
            </div>
        </Messages>
    );
}
