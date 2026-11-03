"use client";

/**
 * Each installed app's build and the newest one published for it, as a hook:
 * the Settings card and the Polaris apps grid draw the same rows and change
 * them through the same actions.
 *
 * Nothing is asked until the component has painted; an update in flight is
 * polled for how far it got, so the bar moves while the download runs. A
 * change shows as under way at once, and the rows only move when the server
 * answers - a refused or failed one leaves the app where it was, with why.
 */

import { z } from "zod";
import type { UpdateRefusal } from "@/lib/app-bundles/releases";
import { useCallback, useEffect, useRef, useState } from "react";
import {
    appUpdatesAction,
    changeAppBuildAction,
    type AppUpdateRow
} from "@/lib/app-bundles/actions";

const POLL_MS = 1_000;

const Progress = z.record(
    z.string(),
    z.object({
        phase: z.enum(["checking", "downloading", "starting"]),
        received: z.number().nonnegative(),
        total: z.number().nonnegative()
    })
);

/** A build as a reader tells two apart: its version and the start of its digest. */
export function buildLabel(build: { version?: string; digest: string }): string {
    const short = build.digest.replace(/^sha256:/, "").slice(0, 7);
    return build.version ? `${build.version} (${short})` : short;
}

/** The newer build published for an app, when there is one. */
export function newerBuild(row: AppUpdateRow): AppUpdateRow["available"] {
    return row.available && row.available.digest !== row.installed?.digest ? row.available : null;
}

/** Whether an app has a newer build this Polaris can run. */
export function canUpdate(row: AppUpdateRow): boolean {
    return Boolean(newerBuild(row)?.runs);
}

/** How far an update has got, as a percentage, or null before the size is known. */
export function progressPercent(row: AppUpdateRow): number | null {
    const progress = row.progress;
    return progress && progress.total > 0
        ? Math.min(100, Math.round((progress.received / progress.total) * 100))
        : null;
}

export interface AppUpdates {
    /** Null until the first answer. */
    readonly rows: AppUpdateRow[] | null;
    /** The rows could not be read at all. */
    readonly failed: boolean;
    /** The app being updated or put back, one at a time. */
    readonly busy: string | null;
    readonly refusals: Readonly<Record<string, UpdateRefusal>>;
    readonly load: (check: boolean) => Promise<void>;
    readonly change: (id: string, kind: "update" | "rollback") => Promise<void>;
    /** Update every app that has a build this Polaris runs, one after another -
     *  only those in `only` when it is given. */
    readonly updateAll: (only?: ReadonlySet<string>) => Promise<void>;
}

export function useAppUpdates({ enabled = true }: { enabled?: boolean } = {}): AppUpdates {
    const [rows, setRows] = useState<AppUpdateRow[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [refusals, setRefusals] = useState<Record<string, UpdateRefusal>>({});
    const poll = useRef<ReturnType<typeof setInterval> | null>(null);
    const latest = useRef<AppUpdateRow[] | null>(null);
    useEffect(() => {
        latest.current = rows;
    }, [rows]);

    const load = useCallback(async (check: boolean) => {
        try {
            setRows(await appUpdatesAction(check));
            setFailed(false);
        } catch {
            setFailed(true);
        }
    }, []);

    const track = useCallback(async (id: string) => {
        try {
            const response = await fetch("/api/app-bundles/progress", { cache: "no-store" });
            if (!response.ok) return;
            const parsed = Progress.safeParse(await response.json());
            if (!parsed.success) return;
            const progress = parsed.data[id];
            if (!progress || !poll.current) return;
            setRows(
                (all) => all?.map((row) => (row.id === id ? { ...row, progress } : row)) ?? all
            );
        } catch {
            return;
        }
    }, []);

    useEffect(() => {
        if (enabled) void load(true);
        return () => {
            if (poll.current) clearInterval(poll.current);
        };
    }, [enabled, load]);

    const change = useCallback(
        async (id: string, kind: "update" | "rollback") => {
            setBusy(id);
            setRefusals(({ [id]: _dropped, ...rest }) => rest);
            poll.current = setInterval(() => void track(id), POLL_MS);
            try {
                const result = await changeAppBuildAction(id, kind);
                setRows(result.rows);
                latest.current = result.rows;
                if (result.refused) setRefusals((all) => ({ ...all, [id]: result.refused! }));
            } catch {
                setRefusals((all) => ({ ...all, [id]: "failed" }));
            } finally {
                if (poll.current) clearInterval(poll.current);
                poll.current = null;
                setBusy(null);
            }
        },
        [track]
    );

    const updateAll = useCallback(
        async (only?: ReadonlySet<string>) => {
            const ids = (latest.current ?? [])
                .filter((row) => canUpdate(row) && (!only || only.has(row.id)))
                .map((row) => row.id);
            for (const id of ids) {
                // Read again after each one: an app the last answer says is current
                // (or no longer installed) is skipped rather than asked twice.
                const row = latest.current?.find((candidate) => candidate.id === id);
                if (row && canUpdate(row)) await change(id, "update");
            }
        },
        [change]
    );

    return { rows, failed, busy, refusals, load, change, updateAll };
}
