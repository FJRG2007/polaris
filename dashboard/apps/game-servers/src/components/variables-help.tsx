"use client";

/**
 * What can be written into a formatted field, on the screen that has one:
 * every value Polaris fills in, what it shows, and the colour codes.
 *
 * Drawn from the same list the field completes from and the server fills in
 * (`text-vars`), so it can never offer a value that is refused, nor leave out one
 * that works.
 */

import * as mc from "../lib/minecraft/motd";
import type { GameKey } from "../../messages";
import { colorName, styleName, useGameText } from "../screens/game-text";
import { Card, CardBody, cn } from "@polaris/ui";
import type { MinecraftEdition } from "../lib/minecraft/service";
import { VARIABLES, type VariableSpec } from "../lib/minecraft/text-vars";

/** The headings the values are read under, in the order they are shown. */
function groupOf(spec: VariableSpec): GameKey<"games"> {
    if (spec.name.startsWith("rank.") || spec.name === "server.levels")
        return "variablesHelp.groups.lists";
    if (spec.name.startsWith("death.")) return "variablesHelp.groups.death";
    if (spec.name.startsWith("call.")) return "variablesHelp.groups.call";
    if (spec.kind === "game" || spec.kind === "account") return "variablesHelp.groups.player";
    return "variablesHelp.groups.server";
}

const GROUP_ORDER: readonly GameKey<"games">[] = [
    "variablesHelp.groups.server",
    "variablesHelp.groups.player",
    "variablesHelp.groups.lists",
    "variablesHelp.groups.death",
    "variablesHelp.groups.call"
];

export function VariablesHelp({
    edition,
    scope,
    className
}: {
    edition: MinecraftEdition;
    /** "server" where the text is the same for everybody (the side panel). */
    scope: "all" | "server";
    /** Set where it shares a column of fixed height and scrolls within it. */
    className?: string;
}) {
    const t = useGameText("games");
    const offered = VARIABLES.filter(
        (spec) =>
            (edition !== "bedrock" || spec.bedrock) && (scope === "all" || spec.kind === "server")
    );
    const groups = GROUP_ORDER.map((label) => ({
        label,
        specs: offered.filter((spec) => groupOf(spec) === label)
    })).filter((group) => group.specs.length > 0);

    return (
        <Card className={cn("overflow-y-auto", className)}>
            <CardBody className="flex flex-col gap-3 text-sm">
                <div>
                    <p className="font-medium">{t("variablesHelp.whatYouCanWrite")}</p>
                    <p className="text-xs text-muted-foreground">
                        {t("variablesHelp.intro")}
                        {scope === "server" && ` ${t("variablesHelp.serverScope")}`}
                    </p>
                </div>
                {groups.map((group) => (
                    <div key={group.label} className="flex flex-col gap-1">
                        <p className="text-[0.6875rem] font-medium uppercase tracking-wider text-foreground-subtle">
                            {t(group.label)}
                        </p>
                        <dl className="flex flex-col gap-1">
                            {group.specs.map((spec) => (
                                <div
                                    key={spec.name}
                                    className="flex flex-wrap items-baseline gap-x-2"
                                >
                                    <dt>
                                        <code className="rounded bg-muted px-1 font-mono text-xs">{`{${spec.name}}`}</code>
                                    </dt>
                                    <dd className="text-xs text-muted-foreground">
                                        {spec.label} - <span className="italic">{spec.sample}</span>
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    </div>
                ))}
                <div className="flex flex-col gap-1">
                    <p className="text-[0.6875rem] font-medium uppercase tracking-wider text-foreground-subtle">
                        {t("variablesHelp.coloursAndStyles")}
                    </p>
                    <p className="text-xs text-muted-foreground">{t("variablesHelp.codesHelp")}</p>
                    <div className="flex flex-wrap gap-1.5">
                        {Object.entries(mc.MOTD_COLORS).map(([code, color]) => (
                            <span
                                key={code}
                                className="flex items-center gap-1 text-xs"
                                title={colorName(t, code)}
                            >
                                <span
                                    className="size-3 rounded-sm border border-border"
                                    style={{ backgroundColor: color.hex }}
                                    aria-hidden="true"
                                />
                                <code className="font-mono">{`&${code}`}</code>
                            </span>
                        ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {Object.keys(mc.MOTD_STYLES)
                            .map((code) => `&${code} ${styleName(t, code).toLowerCase()}`)
                            .join(", ")}
                    </p>
                </div>
            </CardBody>
        </Card>
    );
}
