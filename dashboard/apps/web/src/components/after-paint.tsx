"use client";

/**
 * A region of a server-drawn screen whose data is asked for after the paint.
 *
 * The page sends its shell at once - heading, tabs, the chrome around a table -
 * and this asks for the rest from the browser, showing `skeleton` in its place
 * until the answer lands. The last answer is kept in the tab (`useLiveRead`), so
 * a revisit paints it straight away and the request behind it only swaps what
 * moved; `persist={false}` opts out for an auth or security read.
 *
 * `children` is handed each answer as props, the way a server re-render hands a
 * view new ones. The single exception is the first live answer replacing a kept
 * one that differs: that remounts, so a form seeded from the cache does not keep
 * showing the old values.
 *
 * `revision` is how a mutation that calls `router.refresh()` (or an action that
 * revalidates the path) still reaches data read here: the server page passes a
 * fresh value on every render, and a new one asks again.
 * An answer of `null` is the record being gone, shown as such instead of as a
 * failure.
 */

import { RefreshCw } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, type ReactNode } from "react";
import { Button, EmptyState } from "@polaris/ui";
import { useLiveRead } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function AfterPaint<T>({
    cacheKey,
    load,
    skeleton,
    persist = true,
    revision,
    children
}: {
    /** Names everything the read depends on (an id, a page), so two never share one. */
    cacheKey: string;
    load: () => Promise<T | null>;
    skeleton: ReactNode;
    persist?: boolean;
    /** A value the server page renders anew each time (`Date.now()`). */
    revision?: number;
    children: (data: T) => ReactNode;
}) {
    const t = useTranslations("common");
    // Held in a ref so a caller passing an inline function does not refetch on
    // every render: what is read is named by `cacheKey`.
    const latestLoad = useRef(load);
    latestLoad.current = load;
    const stableLoad = useCallback(async () => ({ value: await latestLoad.current() }), []);
    const { data, error, kept, refresh } = useLiveRead<{ value: T | null }>({
        load: stableLoad,
        cacheKey,
        persist
    });

    const askedFor = useRef(revision);
    useEffect(() => {
        if (revision === undefined || revision === askedFor.current) return;
        askedFor.current = revision;
        refresh();
    }, [revision, refresh]);

    // A new answer object only when something in it changed (`mergeUnchanged`).
    const generation = useRef(0);
    const seen = useRef({ data, kept });
    if (seen.current.data !== data && seen.current.kept && seen.current.data !== null) {
        generation.current += 1;
    }
    seen.current = { data, kept };

    if (data === null) {
        if (!error) return <>{skeleton}</>;
        return (
            <div role="alert">
                <EmptyState
                    title={t("afterPaint.loadFailed")}
                    action={
                        <Button variant="outline" size="sm" onClick={refresh}>
                            <RefreshCw className="size-4 shrink-0" aria-hidden="true" />
                            {t("afterPaint.retry")}
                        </Button>
                    }
                />
            </div>
        );
    }
    if (data.value === null) return <EmptyState title={t("afterPaint.notFound")} />;
    return <Fragment key={generation.current}>{children(data.value)}</Fragment>;
}
