"use client";

/** An experience boost's settings: the extra for each kill and each ore. */

import { Input } from "@polaris/ui";
import { Field, numberOf, problemAt } from "./event-editor";
import { useGameText } from "../game-text";
import type * as catalog from "../../lib/minecraft/events/catalog";

type Value = catalog.EventOptions<"xp-boost">;

export function XpBoostOptions({
    value,
    onChange,
    issues
}: {
    value: Value;
    onChange: (next: Value) => void;
    issues: readonly { path: (string | number)[]; message: string }[];
}) {
    const t = useGameText("minecraft");
    // The rule over both fields at once: one of them has to give something.
    const nothing = issues.find(
        (issue) => issue.path.length === 1 && issue.path[0] === "options"
    )?.message;
    return (
        <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-3">
                <Field
                    label={t("editor.perKill")}
                    hint={t("editor.perKillHint")}
                    problem={problemAt(issues, "options", "perKill")}
                >
                    <Input
                        type="number"
                        min={0}
                        max={100}
                        value={Number.isFinite(value.perKill) ? value.perKill : ""}
                        onChange={(event) =>
                            onChange({ ...value, perKill: numberOf(event.target.value) })
                        }
                    />
                </Field>
                <Field
                    label={t("editor.perOre")}
                    hint={t("editor.perOreHint")}
                    problem={problemAt(issues, "options", "perOre")}
                >
                    <Input
                        type="number"
                        min={0}
                        max={100}
                        value={Number.isFinite(value.perOre) ? value.perOre : ""}
                        onChange={(event) =>
                            onChange({ ...value, perOre: numberOf(event.target.value) })
                        }
                    />
                </Field>
            </div>
            {nothing && <span className="text-xs text-danger">{nothing}</span>}
        </div>
    );
}
