"use client";

/**
 * In-app replacement for the browser's native confirm()/alert() - a promise-based
 * hook so a call site keeps its imperative flow (`if (!(await confirm(...))) return`)
 * while the prompt renders as a themed Dialog. Returns the async confirm function
 * and the element to mount once in the component. `alert: true` shows a single
 * acknowledge button for an informational message.
 */

import { useCallback, useRef, useState, type ReactNode } from "react";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@polaris/ui";

export interface ConfirmOptions {
    title: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    /** Style the confirm button as destructive. */
    danger?: boolean;
    /** Informational: show only an acknowledge button (replaces alert()). */
    alert?: boolean;
}

export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, ReactNode] {
    const [options, setOptions] = useState<ConfirmOptions | null>(null);
    const resolver = useRef<((value: boolean) => void) | null>(null);

    const confirm = useCallback((next: ConfirmOptions) => {
        setOptions(next);
        return new Promise<boolean>((resolve) => {
            resolver.current = resolve;
        });
    }, []);

    const settle = useCallback((value: boolean) => {
        resolver.current?.(value);
        resolver.current = null;
        setOptions(null);
    }, []);

    const element = (
        <Dialog open={options !== null} onOpenChange={(open) => !open && settle(false)}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{options?.title}</DialogTitle>
                    {options?.description ? <DialogDescription>{options.description}</DialogDescription> : null}
                </DialogHeader>
                <div className="flex justify-end gap-2">
                    {options?.alert ? null : (
                        <Button variant="ghost" onClick={() => settle(false)}>
                            {options?.cancelLabel ?? "Cancel"}
                        </Button>
                    )}
                    <Button variant={options?.danger ? "danger" : "primary"} onClick={() => settle(true)}>
                        {options?.confirmLabel ?? (options?.alert ? "OK" : "Confirm")}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );

    return [confirm, element];
}
