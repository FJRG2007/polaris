"use client";

/**
 * The element picker on a framed page, from the window around it: turns the
 * page's picker on and off, and takes what it picks. Shared by the Code
 * preview and a chat's HTML preview.
 *
 * The page is never Polaris's: a message counts only when it comes from this
 * frame, from the opaque origin its sandbox gives it, and reads as the
 * picker's (`readPickerMessage`, which cuts it to size).
 */

import { createContext, useCallback, useEffect, useRef, useState } from "react";
import { PICKER_CHANNEL, readPickerMessage, type PickedElement } from "@/lib/agents/preview-picker";

/** Where a picked element in a chat's HTML preview goes: the composer of the
 *  thread around it. Absent, the preview offers no picker. */
export const PreviewPickContext = createContext<((element: PickedElement) => void) | null>(null);

export function usePreviewPicker(onPick: ((element: PickedElement) => void) | null | undefined) {
    const [picking, setPicking] = useState(false);
    const frame = useRef<HTMLIFrameElement | null>(null);
    const tell = useCallback((action: "start" | "stop") => {
        frame.current?.contentWindow?.postMessage({ type: PICKER_CHANNEL, action }, "*");
    }, []);
    useEffect(() => {
        if (!onPick) return;
        const listen = (event: MessageEvent) => {
            if (!frame.current || event.source !== frame.current.contentWindow || event.origin !== "null") return;
            const message = readPickerMessage(event.data);
            if (!message) return;
            if (message.action === "picked") {
                setPicking(false);
                onPick(message.element);
            } else if (message.action === "stopped") setPicking(false);
            // A page that reloaded while picking picks again.
            else if (picking) tell("start");
        };
        window.addEventListener("message", listen);
        return () => window.removeEventListener("message", listen);
    }, [onPick, picking, tell]);
    useEffect(() => tell(picking ? "start" : "stop"), [picking, tell]);
    return { frame, picking, setPicking };
}
