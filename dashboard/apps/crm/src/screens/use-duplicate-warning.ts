"use client";

/**
 * The note raised when a record just made or changed looks like one already
 * there: which records, by which field, and pressing it opens the first.
 */

import { useCallback } from "react";
import { useCrmT } from "./i18n";
import { useToast } from "@polaris/ui";
import { useRouter } from "next/navigation";
import { recordHref } from "../model/related";
import type { CrmObject } from "../model/objects";
import type { Duplicate } from "../model/duplicates";

export function useDuplicateWarning(object: CrmObject): (found?: readonly Duplicate[]) => void {
    const t = useCrmT();
    const toast = useToast();
    const router = useRouter();
    return useCallback(
        (found: readonly Duplicate[] = []) => {
            const first = found[0];
            if (!first) return;
            toast.show({
                key: `crm-duplicate:${object}`,
                title: t("duplicates.title", { count: found.length }),
                body: t("duplicates.body", {
                    field: t(`fields.${object}.${first.key}` as Parameters<typeof t>[0]),
                    names: found.map((one) => one.name).join(", ")
                }),
                onPress: () => router.push(recordHref(object, first.id))
            });
        },
        [object, router, t, toast]
    );
}
