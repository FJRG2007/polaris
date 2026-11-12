"use client";

import { paintRead } from "../paint-read";
import type { ComponentProps } from "react";
import { UpdatesView } from "./updates-view";
import { CardSkeleton } from "../region-skeletons";
import { AfterPaint } from "@/components/after-paint";

/** The update card, read after the page has painted. Not kept in the tab. */
export function UpdatesViewLoader({
    deployment,
    revision
}: {
    deployment: ComponentProps<typeof UpdatesView>["deployment"];
    revision: number;
}) {
    return (
        <AfterPaint
            cacheKey="admin.updates"
            load={() => paintRead("updates")}
            persist={false}
            revision={revision}
            skeleton={<CardSkeleton lines={3} />}
        >
            {(data) => (
                <UpdatesView
                    initialPolicy={data.policy}
                    initialSource={data.source}
                    deployment={deployment}
                />
            )}
        </AfterPaint>
    );
}
