"use client";

/** The labelled controls the router's dialogs share: a field with its error or hint
 *  beneath, a note that opens to explain a concept, and the VLAN tag picker. */

import { useState } from "react";
import * as ui from "@polaris/ui";
import { HelpCircle } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { nextFreeVlan, vlanError, vlanTakenBy, type PortLink } from "@/lib/router/assist";

type Translate = ReturnType<typeof useTranslations>;

export function Field({
    id,
    label,
    error,
    hint,
    children
}: {
    id: string;
    label: string;
    error?: string | null;
    hint?: string;
    children: React.ReactNode;
}) {
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={id} className="text-sm font-medium">
                {label}
            </label>
            {children}
            {error ? (
                <p role="alert" className="text-xs text-danger">
                    {error}
                </p>
            ) : hint ? (
                <p className="text-xs text-muted-foreground">{hint}</p>
            ) : null}
        </div>
    );
}

/** A concept explained on demand, below the field it is about. */
export function HelpNote({ title, children }: { title: string; children: React.ReactNode }) {
    const [open, setOpen] = useState(false);
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <button
                type="button"
                className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
            >
                <HelpCircle className="size-3.5 shrink-0" />
                {title}
            </button>
            {open ? (
                <div className="rounded-md border border-border bg-surface p-2 text-xs text-muted-foreground">
                    {children}
                </div>
            ) : null}
        </div>
    );
}

/** Who a link is, in a sentence: "internet line 1" or "the Guests network". */
export function whoIs(t: Translate, link: PortLink): string {
    return link.kind === "line"
        ? t("whoLine", { n: link.name })
        : t("whoNetwork", { name: link.name });
}

/** Untagged or a VLAN tag on `port`, with the next free tag offered and a clash with
 *  another line or network named while it is typed. */
export function VlanField({
    id,
    port,
    value,
    links,
    self,
    hint,
    onChange
}: {
    id: string;
    port: string;
    value: number | null;
    /** Every other line and network, to name a clash and find a free tag. */
    links: readonly PortLink[];
    self: { kind: PortLink["kind"]; key: string };
    hint: string;
    onChange: (vlan: number | null) => void;
}) {
    const t = useTranslations("router");
    const [text, setText] = useState(value === null ? "" : String(value));
    const others = links.filter((link) => !(link.kind === self.kind && link.key === self.key));
    const [mode, setMode] = useState<"untagged" | "tagged">(value === null ? "untagged" : "tagged");
    const tagged = mode === "tagged";
    const taken = vlanTakenBy(links, self, port, value);
    const bad = tagged && (value === null || vlanError(value) !== null);
    const error = bad
        ? t("problems.badVlan")
        : taken
          ? value === null
              ? t("untaggedTaken", { port, who: whoIs(t, taken) })
              : t("vlanTaken", { port, vlan: value, who: whoIs(t, taken) })
          : null;

    function choose(next: "untagged" | "tagged"): void {
        setMode(next);
        if (next === "untagged") {
            setText("");
            onChange(null);
            return;
        }
        const free = nextFreeVlan(others, port);
        setText(String(free));
        onChange(free);
    }

    return (
        <div className="flex min-w-0 flex-col gap-1">
            <span id={`${id}-label`} className="text-sm font-medium">
                {t("vlanTag")}
            </span>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <ui.SegmentedControl
                    size="sm"
                    aria-label={t("vlanTag")}
                    value={mode}
                    onValueChange={choose}
                    options={[
                        { value: "untagged", label: t("untagged") },
                        { value: "tagged", label: t("tagged") }
                    ]}
                />
                {tagged ? (
                    <ui.Input
                        id={id}
                        className="w-24 font-mono"
                        inputMode="numeric"
                        aria-labelledby={`${id}-label`}
                        aria-invalid={error !== null}
                        placeholder="10"
                        value={text}
                        onChange={(event) => {
                            const digits = event.target.value.replace(/\D/g, "").slice(0, 4);
                            setText(digits);
                            onChange(digits === "" ? Number.NaN : Number(digits));
                        }}
                    />
                ) : null}
            </div>
            {error ? (
                <p role="alert" className="text-xs text-danger">
                    {error}
                </p>
            ) : (
                <p className="text-xs text-muted-foreground">
                    {tagged ? t("vlanNumberHint") : hint}
                </p>
            )}
            <HelpNote title={t("vlanHelpTitle")}>
                <p>{t("vlanHelp")}</p>
                <p className="mt-1">{t("vlanHelpSwitch")}</p>
            </HelpNote>
        </div>
    );
}
