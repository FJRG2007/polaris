"use client";

/** A Polaris Terminal opened through a link to it: its live output, watched only. */

import { openTerminalLinkAction } from "./actions";
import { TerminalViewer } from "@/app/(app)/account/terminals/terminal-viewer";

export function TerminalGuest({ token, terminalId, name }: { token: string; terminalId: string; name: string }) {
    return <TerminalViewer inline terminalId={terminalId} name={name} open={() => openTerminalLinkAction(token)} />;
}
