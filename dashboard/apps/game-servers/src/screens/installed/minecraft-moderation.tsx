"use client";

/**
 * The Moderation tab: what reaches players' chat that nobody on the server
 * wrote. Mods that announce themselves on every join are found and quietened
 * (`mod-announcements.ts`); each can be let through again here.
 */

import { useGameText } from "../game-text";
import type { GameKey } from "../../../messages";
import { hostUi } from "@polaris/app-host/client";
import { useEffect, useState, useTransition } from "react";
import { Badge, Card, CardBody, Skeleton, Switch } from "@polaris/ui";
import type {
    AnnouncementsState,
    AnnouncerStatus
} from "../../lib/minecraft/mod-announcements-service";
import { RestartPlanner } from "./restart-planner";
import { readAnnouncementsAction, setAnnouncementAction } from "./moderation-actions";

const { writeSnapshot } = hostUi.snapshotCache;
const { useKeptSnapshot } = hostUi.liveRead;
const { mergeUnchanged } = hostUi.structuralMerge;

/** How old the kept list may be and still paint first on a revisit. */
const KEPT_STATE_MS = 24 * 3_600_000;

const STATUS_WORD: Readonly<Record<AnnouncerStatus, GameKey<"minecraft">>> = {
    blocked: "moderation.announcements.blocked",
    allowed: "moderation.announcements.allowed",
    waiting: "moderation.announcements.waiting",
    unreadable: "moderation.announcements.unreadable"
};

const STATUS_TONE: Readonly<Record<AnnouncerStatus, "success" | "warning" | "neutral" | "danger">> =
    {
        blocked: "success",
        allowed: "warning",
        waiting: "neutral",
        unreadable: "danger"
    };

export function MinecraftModeration({
    installedAppId,
    canManage,
    running
}: {
    installedAppId: string;
    canManage: boolean;
    running: boolean;
}) {
    return (
        <div className="flex flex-col gap-4">
            <ModAnnouncementsCard
                installedAppId={installedAppId}
                canManage={canManage}
                running={running}
            />
        </div>
    );
}

function ModAnnouncementsCard({
    installedAppId,
    canManage,
    running
}: {
    installedAppId: string;
    canManage: boolean;
    running: boolean;
}) {
    const t = useGameText("minecraft");
    const stateKey = `mod-announcements:${installedAppId}`;
    const [state, setState] = useState<AnnouncementsState | null>(null);
    useKeptSnapshot<AnnouncementsState>(stateKey, KEPT_STATE_MS, (kept) =>
        setState((current) => current ?? kept.value)
    );
    const [heard, setHeard] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [restartWaiting, setRestartWaiting] = useState(false);

    useEffect(() => {
        if (heard && state) writeSnapshot(stateKey, state);
    }, [heard, stateKey, state]);

    useEffect(() => {
        void readAnnouncementsAction(installedAppId).then((answer) => {
            if (answer.state) {
                const found = answer.state;
                setState((current) => mergeUnchanged(current, found));
                setHeard(true);
                if (found.needsRestart) setRestartWaiting(true);
            } else setError(answer.error ?? t("moderation.announcements.readFailed"));
        });
    }, [installedAppId]);

    function flip(id: string, allow: boolean): void {
        setError(null);
        const before = state;
        // Shown at once; put back if the server refused it.
        setState((current) =>
            current
                ? {
                      ...current,
                      mods: current.mods.map((one) =>
                          one.id === id
                              ? { ...one, allowed: allow, status: allow ? "allowed" : "blocked" }
                              : one
                      )
                  }
                : current
        );
        startTransition(async () => {
            const answer = await setAnnouncementAction({ installedAppId, id, allow });
            if (answer.error || !answer.state) {
                setState(before);
                setError(answer.error ?? t("moderation.announcements.saveFailed"));
                return;
            }
            setState(answer.state);
            if (answer.state.needsRestart) setRestartWaiting(true);
        });
    }

    const mods = state?.mods ?? [];
    const allBlocked = mods.length > 0 && mods.every((one) => one.status === "blocked");

    return (
        <>
            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                            <p className="text-sm font-medium">
                                {t("moderation.announcements.title")}
                            </p>
                            <p className="text-xs text-muted-foreground">
                                {t("moderation.announcements.intro")}
                            </p>
                        </div>
                        {allBlocked ? (
                            <Badge variant="success">
                                {t("moderation.announcements.summaryBlocked")}
                            </Badge>
                        ) : null}
                    </div>
                    {state === null && !error ? (
                        <div className="flex flex-col gap-2" aria-busy="true">
                            <Skeleton className="h-10 w-full" />
                        </div>
                    ) : state && !state.reachable ? (
                        <p className="text-xs text-muted-foreground">
                            {t("moderation.announcements.stopped")}
                        </p>
                    ) : state && mods.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                            {t("moderation.announcements.none")}
                        </p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-border/60">
                            {mods.map((mod) => (
                                <li
                                    key={mod.id}
                                    className="flex items-center justify-between gap-3 py-2"
                                >
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="truncate text-sm" title={mod.name}>{mod.name}</span>
                                            <Badge variant={STATUS_TONE[mod.status]}>
                                                {t(STATUS_WORD[mod.status])}
                                            </Badge>
                                        </div>
                                        <p className="text-xs text-muted-foreground">
                                            {mod.applies === "join"
                                                ? t("moderation.announcements.appliesOnJoin")
                                                : t("moderation.announcements.appliesOnRestart")}
                                        </p>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-2">
                                        <span className="text-xs text-muted-foreground">
                                            {t("moderation.announcements.allow")}
                                        </span>
                                        <Switch
                                            checked={mod.allowed}
                                            disabled={
                                                !canManage ||
                                                pending ||
                                                !heard ||
                                                mod.status === "unreadable"
                                            }
                                            onChange={(allow) => flip(mod.id, allow)}
                                            aria-label={t("moderation.announcements.allowNamed", {
                                                name: mod.name
                                            })}
                                        />
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                    {mods.some((one) => one.status === "waiting") ? (
                        <p className="text-xs text-muted-foreground">
                            {t("moderation.announcements.pendingHint")}
                        </p>
                    ) : null}
                    {mods.some((one) => one.status === "unreadable") ? (
                        <p className="text-xs text-muted-foreground">
                            {t("moderation.announcements.unreadableHint")}
                        </p>
                    ) : null}
                    {error ? (
                        <p role="alert" className="text-xs text-danger">
                            {error}
                        </p>
                    ) : null}
                </CardBody>
            </Card>
            {canManage && restartWaiting ? (
                <RestartPlanner
                    installedAppId={installedAppId}
                    running={running}
                    changed
                    reason={t("moderation.announcements.restartReason")}
                    title={t("moderation.announcements.restartTitle")}
                    detail={t("moderation.announcements.restartDetail")}
                    onRestarted={() => setRestartWaiting(false)}
                />
            ) : null}
        </>
    );
}
