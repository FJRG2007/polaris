"use client";

/** A session's delivered file, opened through a link to it. Read only. */

import { ArtifactViewer, linkArtifactSource } from "@/components/agents/sessions/session-artifacts";
import type { ArtifactVersionView, ArtifactView } from "@/lib/agents/session-artifacts";

export function SharedArtifact({
    token,
    artifact,
    versions
}: {
    token: string;
    artifact: ArtifactView;
    versions: ArtifactVersionView[];
}) {
    return (
        <div className="h-[calc(100dvh-10rem)] min-h-96 overflow-hidden rounded-md border border-border">
            <ArtifactViewer artifact={artifact} versions={versions} source={linkArtifactSource(token)} />
        </div>
    );
}
