/**
 * The server environments. Each one's words - what the choice means and how a
 * domain reaches a server like that - live in the `components` catalog under
 * `environments.<id>`, since the domain setup wizard offers the same choice.
 */

import type { ServerEnvironment } from "@polaris/core";
import type { NamespaceTranslator } from "@/lib/i18n/types";

export interface EnvironmentMeta {
    tone: "primary" | "warning" | "success" | "neutral";
}

export interface EnvironmentWords {
    label: string;
    /** What this choice means, shown while picking. */
    summary: string;
    /** How a domain is pointed at a server like this. */
    routing: string;
}

export const ENVIRONMENT_META: Record<ServerEnvironment, EnvironmentMeta> = {
    "home-nat": { tone: "primary" },
    "home-cgnat": { tone: "warning" },
    vps: { tone: "success" },
    cloud: { tone: "success" },
    unknown: { tone: "neutral" }
};

/** An environment's words, in the reader's language. */
export function environmentWords(
    t: NamespaceTranslator<"components">,
    environment: ServerEnvironment
): EnvironmentWords {
    const id = environment === "home-nat" ? "homeNat" : environment === "home-cgnat" ? "homeCgnat" : environment;
    return {
        label: t(`environments.${id}.label`),
        summary: t(`environments.${id}.summary`),
        routing: t(`environments.${id}.routing`)
    };
}

/** The answerable options in the order they are offered; `unknown` is a state, not a choice. */
export const ENVIRONMENT_CHOICES: ServerEnvironment[] = ["home-nat", "home-cgnat", "vps", "cloud"];
