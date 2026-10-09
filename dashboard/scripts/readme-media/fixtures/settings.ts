/** A deployment one release behind, on a home server with a domain of its own. */

import { ago } from "./people";
import type { SceneContext } from "../runtime/scene";
import type { UpdateStatus } from "@/lib/update-service";
import type { UpdateLogTail } from "@/lib/update-log";
import type { SettingsOverview } from "@/app/(app)/admin/settings/overview";

export const DEPLOYMENT = {
    hostname: "polaris",
    repo: "example/polaris",
    branch: "main",
    autoUpdate: true
} as const;

export function updateStatus(ctx: SceneContext): UpdateStatus {
    return {
        phase: "available",
        source: "image",
        current: "3f1c2a9",
        latest: "8b7e410",
        behindBy: 4,
        upToDate: false,
        buildingCount: null,
        publishedAt: ago(ctx.now, 95),
        checks: "passed",
        checksUrl: null,
        url: "https://github.com/example/polaris/compare/3f1c2a9...8b7e410",
        checkedAt: ago(ctx.now, 2)
    };
}

export function settingsOverview(ctx: SceneContext): SettingsOverview {
    const checked = ago(ctx.now, 1);
    const up = { state: "up" as const, checkedAt: checked, detail: null };
    return {
        status: updateStatus(ctx),
        addresses: [
            {
                url: "https://polaris.example.com",
                host: "polaris.example.com",
                kind: "domain",
                health: up
            },
            { url: "http://polaris.local", host: "polaris.local", kind: "local", health: up }
        ],
        // Documentation ranges (RFC 5737), which route nowhere.
        publicIp: "203.0.113.24",
        serverIp: "192.0.2.10"
    };
}

/** The update log of a run that finished long ago: nothing to re-attach to. */
export function quietUpdateLog(ctx: SceneContext): UpdateLogTail {
    return {
        exists: false,
        content: "",
        nextOffset: 0,
        size: 0,
        done: true,
        exitCode: null,
        finished: true,
        updatedAt: 0,
        now: ctx.now,
        build: "3f1c2a9"
    };
}
