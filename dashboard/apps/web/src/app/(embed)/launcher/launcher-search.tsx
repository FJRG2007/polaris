"use client";

import { useMemo } from "react";
import { CommandPalette } from "@/components/command-palette";
import { isInstancePath, type SearchHost } from "@/lib/search/search-host";

/** What Polaris Desktop's search window exposes to this page (its preload). */
interface DesktopLauncherBridge {
    query(text: string, mode: "host-only"): Promise<unknown>;
    run(id: string): Promise<boolean>;
    hide(): Promise<void>;
    open(href: string): Promise<void>;
    onOpened(listener: () => void): void;
}

declare global {
    interface Window {
        polarisLauncher?: Partial<DesktopLauncherBridge>;
    }
}

/**
 * The dashboard's own palette, given the desktop window as its host. Opened in
 * a plain browser tab there is no bridge: results open in this tab and only
 * the palette's own rows are listed, which is still the same search.
 */
export function LauncherSearch({
    isAdmin,
    appIds,
    held,
    installed
}: {
    isAdmin: boolean;
    appIds: string[];
    held: string[];
    installed: string[];
}) {
    const host = useMemo<SearchHost>(() => {
        const bridge = typeof window === "undefined" ? undefined : window.polarisLauncher;
        // Feature-detected call by call: a desktop build that predates one of
        // them still gets everything else.
        return {
            query: (text) =>
                typeof bridge?.query === "function"
                    ? bridge.query(text, "host-only")
                    : Promise.resolve({ rows: [] }),
            run: (id) => void bridge?.run?.(id),
            navigate: (href) => {
                if (!isInstancePath(href)) return;
                if (typeof bridge?.open === "function") void bridge.open(href);
                else window.location.assign(href);
            },
            close: () => void bridge?.hide?.(),
            onOpened: (listener) => bridge?.onOpened?.(listener)
        };
    }, []);
    return <CommandPalette host={host} isAdmin={isAdmin} appIds={appIds} held={held} installed={installed} />;
}
