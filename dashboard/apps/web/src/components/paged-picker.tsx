"use client";

/**
 * A picker over any list a server action answers a page at a time: the search
 * and the cursor go to the action, so the browser never holds more than the
 * pages somebody scrolled through. A screen supplies the action and what is
 * fixed about the list (`scope`); the picker supplies the paging.
 */

import * as ui from "@polaris/ui";
import { useCallback } from "react";

/** A server action that answers a page, or an error sentence. */
export type PageReader<T> = (
    input: Record<string, unknown>
) => Promise<{ items: T[]; next: string | null } | { error: string }>;

/** A page loader and an id resolver over one action, keyed by what is asked. */
export function usePaged<T>(read: PageReader<T>, scope: Record<string, unknown>) {
    const key = JSON.stringify(scope);
    const load = useCallback<ui.AsyncLoad<T>>(
        async ({ query, cursor }) => {
            const result = await read({ ...JSON.parse(key), query, cursor });
            if ("error" in result) throw new Error(result.error);
            return result;
        },
        [key, read]
    );
    const resolve = useCallback(
        async (id: string) => {
            const result = await read({ ...JSON.parse(key), ids: [id] });
            return "error" in result ? null : (result.items[0] ?? null);
        },
        [key, read]
    );
    return { load, resolve, key };
}

interface PagedProps<T> {
    read: PageReader<T>;
    /** What is fixed about the list - sent with every page. */
    scope: Record<string, unknown>;
    /** The cache the pages live under; the scope is added to it. */
    cache: string;
    itemLabel?: (item: T) => string;
    itemDetail?: (item: T) => string | null | undefined;
    fixed?: readonly ui.AsyncFixedOption[];
    placeholder: string;
    searchPlaceholder: string;
    emptyText: string;
    disabled?: boolean;
    className?: string;
    id?: string;
    "aria-label"?: string;
}

const idOf = (item: { id: string }) => item.id;
const nameOf = (item: { name: string }) => item.name;

export function PagedPicker<T extends { id: string; name: string }>({
    read,
    scope,
    cache,
    itemLabel,
    ...rest
}: PagedProps<T> & {
    value: string | null;
    onValueChange: (id: string, item: T | null) => void;
    selectedLabel?: string;
}) {
    const { load, resolve, key } = usePaged<T>(read, scope);
    return (
        <ui.AsyncSelect<T>
            {...rest}
            load={load}
            resolve={resolve}
            cacheKey={`${cache}:${key}`}
            itemValue={idOf}
            itemLabel={itemLabel ?? nameOf}
        />
    );
}

export function PagedMultiPicker<T extends { id: string; name: string }>({
    read,
    scope,
    cache,
    itemLabel,
    ...rest
}: PagedProps<T> & {
    values: readonly string[];
    onValuesChange: (ids: string[]) => void;
    selectedLabels?: Readonly<Record<string, string>>;
}) {
    const { load, resolve, key } = usePaged<T>(read, scope);
    return (
        <ui.AsyncMultiSelect<T>
            {...rest}
            load={load}
            resolve={resolve}
            cacheKey={`${cache}:${key}`}
            itemValue={idOf}
            itemLabel={itemLabel ?? nameOf}
        />
    );
}
