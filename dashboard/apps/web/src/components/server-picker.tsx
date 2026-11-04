"use client";

/**
 * The one way a screen asks somebody to pick a server.
 *
 * Reads the servers the person may use a page at a time, searched by name or
 * address on the server, so an account with five thousand of them opens this as
 * fast as one with five. What a screen needs left out - servers that are not
 * root, already a VPN node, the one being moved away from - is a `filter` the
 * query applies, never a list narrowed in the browser.
 */

import * as ui from "@polaris/ui";
import { useCallback } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { listServerOptionsAction } from "@/app/(app)/server-options-actions";
import type { ServerFilter, ServerOption, ServerPurpose } from "@/lib/server-options-schema";

/** The cache every server picker's pages live under. */
export const SERVER_OPTIONS_CACHE = "servers:";

/** Whose servers, under which filters - everything but the search and the page. */
interface ServerScope {
    filter?: ServerFilter;
    /** Offer the machine Polaris runs on first, under the id `local`. */
    includeLocal?: boolean;
    /** A project environment's servers - its owner's - rather than the caller's. */
    environmentId?: string;
    /** A feature that picks under its own grant, such as an agent session. */
    purpose?: ServerPurpose;
}

async function readPage(
    query: string,
    cursor: string | null,
    scope: ServerScope
): Promise<ui.AsyncPage<ServerOption>> {
    const result = await listServerOptionsAction({ ...scope, query, cursor });
    if ("error" in result) throw new Error(result.error);
    return result;
}

/** Forget the pages pickers hold - after a server is added, renamed or removed. */
export function dropServerOptions(): void {
    ui.dropAsyncOptions(SERVER_OPTIONS_CACHE);
}

interface CommonProps extends ServerScope {
    /** Choices above the servers - "Any server", "This machine". */
    fixed?: readonly ui.AsyncFixedOption[];
    placeholder?: string;
    disabled?: boolean;
    className?: string;
    id?: string;
    "aria-label"?: string;
}

function useServerLoad({ filter, includeLocal, environmentId, purpose }: ServerScope) {
    // The key is the scope: a new object with the same filters is the same list.
    const key = JSON.stringify({ filter: filter ?? {}, includeLocal, environmentId, purpose });
    const load = useCallback<ui.AsyncLoad<ServerOption>>(
        ({ query, cursor }) => readPage(query, cursor, JSON.parse(key) as ServerScope),
        [key]
    );
    const resolve = useCallback(
        async (id: string) => {
            const scope = JSON.parse(key) as ServerScope;
            const result = await listServerOptionsAction({ ...scope, ids: [id] });
            return "error" in result ? null : (result.items[0] ?? null);
        },
        [key]
    );
    return { load, resolve, cacheKey: `${SERVER_OPTIONS_CACHE}${key}` };
}

const itemValue = (server: ServerOption) => server.id;
const itemLabel = (server: ServerOption) => server.name;
const itemDetail = (server: ServerOption) => server.address;

export function ServerPicker({
    value,
    onValueChange,
    selectedLabel,
    filter,
    includeLocal,
    environmentId,
    purpose,
    placeholder,
    ...rest
}: CommonProps & {
    value: string | null;
    /** The server is null for one of the `fixed` choices. */
    onValueChange: (id: string, server: ServerOption | null) => void;
    /** The chosen server's name, when the screen already has it. */
    selectedLabel?: string;
}) {
    const t = useTranslations("components");
    const { load, resolve, cacheKey } = useServerLoad({
        filter,
        includeLocal,
        environmentId,
        purpose
    });
    return (
        <ui.AsyncSelect<ServerOption>
            {...rest}
            value={value}
            onValueChange={onValueChange}
            selectedLabel={selectedLabel}
            load={load}
            cacheKey={cacheKey}
            resolve={resolve}
            itemValue={itemValue}
            itemLabel={itemLabel}
            itemDetail={itemDetail}
            placeholder={placeholder ?? t("serverPicker.placeholder")}
            searchPlaceholder={t("serverPicker.search")}
            emptyText={t("serverPicker.empty")}
        />
    );
}

export function ServerMultiPicker({
    values,
    onValuesChange,
    selectedLabels,
    filter,
    includeLocal,
    environmentId,
    purpose,
    placeholder,
    ...rest
}: CommonProps & {
    values: readonly string[];
    onValuesChange: (ids: string[]) => void;
    selectedLabels?: Readonly<Record<string, string>>;
}) {
    const t = useTranslations("components");
    const { load, resolve, cacheKey } = useServerLoad({
        filter,
        includeLocal,
        environmentId,
        purpose
    });
    return (
        <ui.AsyncMultiSelect<ServerOption>
            {...rest}
            values={values}
            onValuesChange={onValuesChange}
            selectedLabels={selectedLabels}
            load={load}
            cacheKey={cacheKey}
            resolve={resolve}
            itemValue={itemValue}
            itemLabel={itemLabel}
            itemDetail={itemDetail}
            placeholder={placeholder ?? t("serverPicker.placeholderMany")}
            searchPlaceholder={t("serverPicker.search")}
            emptyText={t("serverPicker.empty")}
        />
    );
}
