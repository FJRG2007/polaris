"use client";

/**
 * Client-side capability context. The server computes the current Capabilities
 * (which edition, what host access) and hands them to this provider; components
 * read them to badge or hide features. This is presentation only - the server
 * always re-checks capabilities before performing a privileged action, so a
 * tampered client can reveal a control but never actually use it.
 */

import { createContext, useContext, type ReactNode } from "react";
import { Lock } from "lucide-react";
import type { Capabilities } from "@polaris/config";
import { Badge } from "../components/badge.js";

const CapabilityContext = createContext<Capabilities | null>(null);

export function CapabilityProvider({
    capabilities,
    children
}: {
    capabilities: Capabilities;
    children: ReactNode;
}) {
    return <CapabilityContext.Provider value={capabilities}>{children}</CapabilityContext.Provider>;
}

export function useCapabilities(): Capabilities {
    const value = useContext(CapabilityContext);
    if (!value) throw new Error("useCapabilities must be used within a CapabilityProvider");
    return value;
}

/** Badge marking a feature that needs the full edition's host daemon. */
export function LockedBadge({ label = "Unlock host access" }: { label?: string }) {
    return (
        <Badge variant="neutral" title="Requires the full edition (polaris-hostd)">
            <Lock className="size-3" />
            {label}
        </Badge>
    );
}

/** Shows the running edition. */
export function EditionBadge() {
    const caps = useCapabilities();
    return (
        <Badge variant={caps.edition === "full" ? "primary" : "neutral"}>
            {caps.edition === "full" ? "Full edition" : "Limited edition"}
        </Badge>
    );
}
