"use client";

/**
 * Whether one domain answers. Moves under the finger and only moves back if the
 * server refuses, saying why in a toast; used by the domain lists in the service
 * view and in its Settings.
 */

import { setDomainEnabledAction } from "./actions";
import { Switch, useOptimisticToggle } from "@polaris/ui";

export function DomainEnabledSwitch({
    domainId,
    enabled,
    label,
    onChanged
}: {
    domainId: string;
    enabled: boolean;
    /** The switch's accessible name for the position it is in. */
    label: (on: boolean) => string;
    onChanged: () => void;
}) {
    const [on, toggle] = useOptimisticToggle(enabled, async (next) => {
        const result = await setDomainEnabledAction(domainId, next);
        if (!result.error) onChanged();
        return result;
    });
    return <Switch checked={on} onChange={toggle} aria-label={label(on)} />;
}
