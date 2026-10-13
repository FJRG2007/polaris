"use client";

/**
 * Whether a record or a view is pinned to the CRM's rail, and the toggle.
 *
 * The star turns at once and turns back if the server refuses; the rail is
 * told to read its favorites again once the change is kept.
 */

import { useCrmT } from "./i18n";
import { useToast } from "@polaris/ui";
import { messageOf, unwrap } from "./call";
import * as actions from "../actions/favorites";
import { hostUi } from "@polaris/app-host/client";
import type { CrmObject } from "../model/objects";
import { useCallback, useEffect, useState } from "react";

export function useFavorite(
    kind: "record" | "view",
    object: CrmObject,
    targetId: string | null,
    known: boolean
): { pinned: boolean; toggle: () => void } {
    const t = useCrmT();
    const toast = useToast();
    const [pinned, setPinned] = useState(known);
    useEffect(() => setPinned(known), [known, targetId]);

    const toggle = useCallback(() => {
        if (!targetId) return;
        const next = !pinned;
        setPinned(next);
        unwrap(
            () => actions.setFavoriteAction({ kind, object, targetId, pinned: next }),
            t("errors.generic")
        )
            .then(() => {
                hostUi.appFavorites.refreshAppFavorites("crm");
                toast.show({ title: t(next ? "favorites.added" : "favorites.removed") });
            })
            .catch((caught) => {
                setPinned(!next);
                toast.show({ title: t("favorites.notSaved"), body: messageOf(caught) });
            });
    }, [kind, object, targetId, pinned, t, toast]);

    return { pinned, toggle };
}
