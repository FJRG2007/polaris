"use client";

/**
 * Client-side capability context. The server computes what host access this
 * install actually has and hands it to this provider; components read it to hide
 * features that cannot work. This is presentation only - the server always
 * re-checks before performing a privileged action, so a tampered client can
 * reveal a control but never actually use it.
 *
 * There is deliberately nothing here that draws the answer as a label. Polaris
 * installs one way and is one thing; a badge in the top bar reading "Full
 * edition" or "Limited edition" depending on whether a probe happened to answer
 * told the reader nothing they could act on and, because the probe is a live
 * check, said different things on different loads of the same install.
 */

import type { Capabilities } from "@polaris/config";
import { createContext, useContext, type ReactNode } from "react";

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
