/**
 * What a container's state is called where a person reads it.
 *
 * The engine reports its own words (`running`, `exited`, `created`...), which are
 * codes rather than sentences; they are shown as `states.<state>` from the
 * `containers` catalog, and a state a newer engine invents is shown as it came.
 */

import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";

const STATES = new Set(["running", "exited", "created", "paused", "restarting", "removing", "dead"]);

export function containerStateLabel(t: NamespaceTranslator<"containers">, state: string): string {
    return STATES.has(state) ? t(`states.${state}` as NamespaceKey<"containers">) : state;
}
