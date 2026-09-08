"use client";

/**
 * How a drawing gets exported by the chrome above it.
 *
 * Four of the five kinds export on the server: the document is read out of
 * storage, turned into bytes and downloaded through a link. A drawing cannot,
 * because rendering one means having drawn it - and the canvas that has already
 * drawn it is in the browser, three components below the menu.
 *
 * So the editor registers what it can do and the menu calls it. A context rather
 * than a module-level variable, because two documents open in two tabs of one
 * browser are two canvases, and a shared variable would have the second one
 * exporting the first.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/** What an editor can hand back: the bytes of one format, or null when it
 *  cannot. */
export type BrowserExporter = (format: string) => Promise<Blob | null>;

interface Slot {
    readonly exporter: BrowserExporter | null;
    readonly register: (exporter: BrowserExporter | null) => void;
}

const ExportSlot = createContext<Slot | null>(null);

export function OfficeExportProvider({ children }: { children: React.ReactNode }) {
    const [exporter, setExporter] = useState<BrowserExporter | null>(null);
    const register = useCallback((next: BrowserExporter | null) => {
        // Wrapped, because React calls a function passed to a setter rather than
        // storing it - and what is being stored here IS a function.
        setExporter(() => next);
    }, []);
    const value = useMemo<Slot>(() => ({ exporter, register }), [exporter, register]);
    return <ExportSlot.Provider value={value}>{children}</ExportSlot.Provider>;
}

/** Called by the chrome. Null when whatever is open exports on the server. */
export function useBrowserExporter(): BrowserExporter | null {
    return useContext(ExportSlot)?.exporter ?? null;
}

/**
 * Called by an editor that can export itself.
 *
 * Held in a ref and registered once, so an editor that rebuilds its exporter on
 * every render - which any editor closing over its own scene does - does not
 * re-register on every keystroke.
 */
export function useRegisterExporter(exporter: BrowserExporter): void {
    const slot = useContext(ExportSlot);
    const held = useRef(exporter);
    held.current = exporter;

    useEffect(() => {
        if (!slot) return;
        slot.register((format) => held.current(format));
        return () => slot.register(null);
        // Only the slot: the exporter itself is read through the ref.
    }, [slot]);
}
