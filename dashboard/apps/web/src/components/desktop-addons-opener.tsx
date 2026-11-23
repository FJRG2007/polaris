"use client";

/**
 * Opens an add-on's page when the desktop app asks for it - its "device found"
 * notice was clicked. Nothing is drawn, and nothing runs outside the app.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useDesktopBridge } from "@/components/desktop-app";

const ID = /^[a-z][a-z0-9-]{1,47}$/;

export function DesktopAddonsOpener() {
    const bridge = useDesktopBridge();
    const router = useRouter();
    useEffect(() => {
        const addons = bridge?.addons;
        if (!addons) return;
        return addons.onOpen((id) => {
            if (typeof id === "string" && ID.test(id)) router.push(`/account/addons/${id}`);
        });
    }, [bridge, router]);
    return null;
}
