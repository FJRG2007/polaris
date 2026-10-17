"use client";

/**
 * The automations list as an installable app's screen draws it: on a route none
 * of our layouts wraps, so it brings its own namespace with it.
 */

import { ClientMessages } from "@/components/i18n/client-namespaces";
import { AutomationsList } from "./automations-list";
import { RowsSkeleton } from "./shared";

export function EmbeddedAutomationsList(props: Parameters<typeof AutomationsList>[0]) {
    return (
        <ClientMessages namespaces={["automations"]} fallback={<RowsSkeleton />}>
            <AutomationsList {...props} />
        </ClientMessages>
    );
}
