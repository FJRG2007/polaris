"use client";

/**
 * Opens a plugin's page when the desktop app asks for it - its "device found"
 * notice was clicked. Nothing is drawn, and nothing runs outside the app.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useDesktopBridge } from "@/components/desktop-app";

const ID = /^[a-z][a-z0-9-]{1,47}$/;

export function DesktopPluginsOpener() {
    const bridge = useDesktopBridge();
    const router = useRouter();
    useEffect(() => {
        // An app from before the rename answers under `addons`.
        const plugins = bridge?.plugins ?? bridge?.addons;
        if (!plugins) return;
        return plugins.onOpen((id) => {
            if (typeof id === "string" && ID.test(id)) router.push(`/account/plugins/${id}`);
        });
    }, [bridge, router]);
    return null;
}
