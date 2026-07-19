"use client";

/**
 * "New drop point" action for the Drop points page. Opens the request dialog in
 * picker mode (no fixed folder), so the user chooses which connection and folder
 * to collect uploads into - the same dialog used from the Files browser.
 */

import { useState } from "react";
import { Inbox } from "lucide-react";
import { Button } from "@polaris/ui";
import { RequestDialog, type RequestTarget } from "../request-dialog";

export function NewDropPointButton({ connections }: { connections: { id: string; name: string }[] }) {
    const [target, setTarget] = useState<RequestTarget | null>(null);

    return (
        <>
            <Button
                size="sm"
                onClick={() => setTarget({ connectionId: "", path: "", name: "" })}
                disabled={connections.length === 0}
            >
                <Inbox className="size-4" />
                New drop point
            </Button>
            <RequestDialog
                target={target}
                connections={connections}
                onOpenChange={(open) => !open && setTarget(null)}
            />
        </>
    );
}
