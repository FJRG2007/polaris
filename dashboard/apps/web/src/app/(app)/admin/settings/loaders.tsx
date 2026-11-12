"use client";

import { paintRead } from "../paint-read";
import type { ComponentProps } from "react";
import { SettingsView } from "./settings-view";
import { CardSkeleton } from "../region-skeletons";
import { AfterPaint } from "@/components/after-paint";
import { TerminalSessionsCard } from "./terminal-card";

/**
 * The settings screen's two regions, each its own read so neither waits for
 * the other. The contact is not kept in the tab.
 */
export function SettingsViewLoader({
    deployment,
    revision
}: {
    deployment: ComponentProps<typeof SettingsView>["deployment"];
    revision: number;
}) {
    return (
        <AfterPaint
            cacheKey="admin.settings"
            load={() => paintRead("settings")}
            persist={false}
            revision={revision}
            skeleton={
                <div className="flex flex-col gap-4">
                    <CardSkeleton lines={3} />
                    <CardSkeleton lines={2} />
                </div>
            }
        >
            {(data) => (
                <SettingsView
                    initialContact={data.contact}
                    publicPages={data.publicPages}
                    deployment={deployment}
                />
            )}
        </AfterPaint>
    );
}

export function SettingsCardsLoader({ max, revision }: { max: number; revision: number }) {
    return (
        <AfterPaint
            cacheKey="admin.settings.cards"
            load={() => paintRead("settings.cards")}
            revision={revision}
            skeleton={
                <div className="mt-4 flex flex-col gap-4">
                    <CardSkeleton lines={1} />
                </div>
            }
        >
            {(data) => <TerminalSessionsCard cap={data.terminalCap} max={max} />}
        </AfterPaint>
    );
}
