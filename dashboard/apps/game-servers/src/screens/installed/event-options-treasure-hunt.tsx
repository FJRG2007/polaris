"use client";

/** A treasure hunt's settings: how far out its one treasure is, and what is in it. */

import { Input, Select } from "@polaris/ui";
import type * as catalog from "../../lib/minecraft/events/catalog";
import { Field, LOOT_LABELS, numberOf, options, problemAt } from "./event-editor";
import { useGameText } from "../game-text";

type Value = catalog.EventOptions<"treasure-hunt">;

export function TreasureHuntOptions({
    value,
    onChange,
    issues
}: {
    value: Value;
    onChange: (next: Value) => void;
    issues: readonly { path: (string | number)[]; message: string }[];
}) {
    const t = useGameText("minecraft");
    return (
        <>
            <div className="grid grid-cols-2 gap-3">
                <Field
                    label={t("editor.howFarOut")}
                    hint={t("editor.howFarOutHint")}
                    problem={problemAt(issues, "options", "distance")}
                >
                    <Input
                        type="number"
                        min={50}
                        max={1000}
                        value={Number.isFinite(value.distance) ? value.distance : ""}
                        onChange={(event) =>
                            onChange({ ...value, distance: numberOf(event.target.value) })
                        }
                    />
                </Field>
            </div>
            <Field label={t("editor.whatIsInside")}>
                <Select
                    value={value.loot}
                    onValueChange={(loot) => onChange({ ...value, loot: loot as Value["loot"] })}
                    options={options(t, LOOT_LABELS)}
                    aria-label={t("editor.whatIsInside")}
                />
            </Field>
        </>
    );
}
