"use client";

/**
 * Privacy for one camera or a group, shared by the wall and the list.
 *
 * Shown at once, then each camera's own answer replaces it: one that refused
 * goes back on its own, and a call that failed outright puts every camera back.
 */

import * as actions from "./actions";
import { usePlacesT } from "./use-places-t";
import type { CameraView } from "../lib/cameras";
import { useState, type Dispatch, type SetStateAction } from "react";
import {
    applyPrivacy,
    rollbackPrivacy,
    settlePrivacy,
    targetKey,
    type PrivacyTarget
} from "../lib/privacy-kinds";

/** The cameras that refused because their certificate changed, kept so the
 *  same switch can be tried again trusting them. */
export interface UntrustedSwitch {
    target: PrivacyTarget;
    ids: readonly string[];
    cameraIds: readonly string[];
    wanted: boolean;
}

export interface CameraPrivacy {
    switchPrivacy: (
        target: PrivacyTarget,
        ids: readonly string[],
        wanted: boolean,
        trusting?: readonly string[]
    ) => Promise<void>;
    error: string | null;
    untrusted: UntrustedSwitch | null;
}

export function useCameraPrivacy({
    cameras,
    setCameras,
    canManage,
    onPublicAgain
}: {
    cameras: readonly CameraView[] | null;
    setCameras: Dispatch<SetStateAction<CameraView[] | null>>;
    canManage: boolean;
    /** A camera made public again is back on the relay: the caller asks which
     *  streams it serves now. */
    onPublicAgain: () => void;
}): CameraPrivacy {
    const t = usePlacesT();
    const [error, setError] = useState<string | null>(null);
    const [untrusted, setUntrusted] = useState<UntrustedSwitch | null>(null);

    async function switchPrivacy(
        target: PrivacyTarget,
        ids: readonly string[],
        wanted: boolean,
        trusting: readonly string[] = []
    ) {
        const list = cameras ?? [];
        const before = new Map(
            list
                .filter((camera) => ids.includes(camera.id))
                .map((camera) => [camera.id, camera.privacy])
        );
        setError(null);
        setUntrusted(null);
        setCameras((current) => applyPrivacy(current ?? [], ids, wanted));
        const result =
            trusting.length > 0
                ? await actions.trustCamerasAgainAction(trusting, targetKey(target), wanted)
                : await actions.cameraPrivacyAction(targetKey(target), wanted);
        if (result.error || !result.results) {
            setCameras((current) => rollbackPrivacy(current ?? [], before));
            setError(result.error ?? t("privacy.failed"));
            return;
        }
        const results = result.results;
        setCameras((current) => settlePrivacy(current ?? [], results));
        if (results.some((row) => !row.private && before.get(row.cameraId))) onPublicAgain();
        const failed = results.filter((row) => row.failure);
        if (failed.length === 0) return;
        const first = failed[0];
        const refused = failed
            .filter((row) => row.failure === "certificate")
            .map((row) => row.cameraId);
        if (canManage && refused.length > 0)
            setUntrusted({ target, ids, cameraIds: refused, wanted });
        const reason =
            first?.failure === "locked"
                ? t("privacy.locked", { seconds: first.waitSeconds ?? 0 })
                : t(`privacy.${first?.failure ?? "failed"}`);
        setError(
            `${t("privacy.failedSome", {
                count: failed.length,
                total: results.length,
                names: failed.map((row) => row.name).join(", ")
            })} ${reason}`
        );
    }

    return { switchPrivacy, error, untrusted };
}
