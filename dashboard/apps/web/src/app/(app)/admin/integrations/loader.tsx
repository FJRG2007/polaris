"use client";

import { useMemo } from "react";
import { paintRead } from "../paint-read";
import { TableSkeleton } from "../region-skeletons";
import { AfterPaint } from "@/components/after-paint";
import { IntegrationsView, type IntegrationCard } from "./integrations-view";

/** The integration cards. Not kept in the tab: they say which secrets are set. */
export function IntegrationsLoader({
    configure,
    revision
}: {
    configure: string | null;
    revision: number;
}) {
    return (
        <AfterPaint
            cacheKey="admin.integrations"
            load={() => paintRead("integrations")}
            persist={false}
            revision={revision}
            skeleton={<TableSkeleton rows={8} />}
        >
            {(data) => (
                <IntegrationsRegion
                    cards={data.cards}
                    githubConnected={data.githubConnected}
                    configure={configure}
                />
            )}
        </AfterPaint>
    );
}

function IntegrationsRegion({
    cards,
    githubConnected,
    configure
}: {
    cards: IntegrationCard[];
    githubConnected: boolean;
    configure: string | null;
}) {
    // Asked once per connection state; only the note in the GitHub dialog waits
    // for it, and a failed check leaves the note out.
    const runners = useMemo(
        () =>
            githubConnected
                ? paintRead("integrations.runners").catch(() => null)
                : undefined,
        [githubConnected]
    );
    return <IntegrationsView cards={cards} runnerAccess={runners} configure={configure} />;
}
