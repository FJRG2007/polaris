"use client";

/**
 * A field's value as a cell draws it: a link where there is somewhere to go (an
 * address, a phone number, a website), a face beside an owner, a chip for a
 * related record or a stage, and nothing at all for an empty field - an empty
 * cell reads as empty faster than a dash does.
 */

import { cn } from "@polaris/ui";
import { useCrmT } from "./i18n";
import { plainText } from "./format";
import { hostUi } from "@polaris/app-host/client";
import { Building2, Check, Target, User } from "lucide-react";
import type { CrmObject, FieldDef, FieldValue, Ref } from "../model/objects";

const { Avatar } = hostUi.avatar;

/** The hues the options of a choice are told apart by, in option order. */
const OPTION_DOTS = ["bg-sky-500", "bg-violet-500", "bg-amber-500", "bg-orange-500", "bg-emerald-500"];

export function optionDot(field: FieldDef, option: string): string {
    const index = field.options?.indexOf(option) ?? -1;
    return OPTION_DOTS[index % OPTION_DOTS.length] ?? "bg-foreground-subtle";
}

const REF_ICON: Readonly<Record<CrmObject, typeof Building2>> = {
    companies: Building2,
    people: User,
    opportunities: Target
};

/** A related record, as a chip. */
export function RefChip({ target, value }: { target: CrmObject; value: Ref }) {
    const Icon = REF_ICON[target];
    return (
        <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded border border-border bg-muted/60 px-1.5 py-0.5 text-[0.75rem]">
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate" title={value.name}>
                {value.name}
            </span>
        </span>
    );
}

/** A choice, as a chip with its dot. */
export function OptionChip({ field, option, label }: { field: FieldDef; option: string; label: string }) {
    return (
        <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded border border-border px-1.5 py-0.5 text-[0.75rem]">
            <span className={cn("size-2 shrink-0 rounded-full", optionDot(field, option))} />
            <span className="truncate" title={label}>{label}</span>
        </span>
    );
}

/** An owner, as a face and a name. */
export function MemberLine({ value }: { value: Ref }) {
    return (
        <span className="flex min-w-0 items-center gap-1.5">
            <Avatar person={{ id: value.id, name: value.name }} size={20} status={false} />
            <span className="truncate" title={value.name}>
                {value.name}
            </span>
        </span>
    );
}

/** Stops a link inside a cell from also opening the cell's editor. */
const keep = (event: { stopPropagation: () => void }) => event.stopPropagation();

function ExternalLink({ href, children }: { href: string; children: string }) {
    return (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            onClick={keep}
            className="truncate text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
            title={href}
        >
            {children}
        </a>
    );
}

export function CellDisplay({
    object,
    field,
    value
}: {
    object: CrmObject;
    field: FieldDef;
    value: FieldValue | undefined;
}) {
    const t = useCrmT();
    const format = hostUi.displayFormat.useDisplayFormat();
    const locale = hostUi.i18nProvider.useLocale();
    if (field.kind === "boolean") {
        return value ? (
            <Check className="size-4 text-foreground" aria-label={t("values.yes")} />
        ) : (
            <span className="sr-only">{t("values.no")}</span>
        );
    }
    if (value === null || value === undefined || value === "") return null;
    switch (field.kind) {
        case "email":
            return (
                <a
                    href={`mailto:${value as string}`}
                    onClick={keep}
                    className="truncate text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
                    title={value as string}
                >
                    {value as string}
                </a>
            );
        case "phone":
            return (
                <a href={`tel:${(value as string).replace(/[^\d+]/g, "")}`} onClick={keep} className="truncate">
                    {value as string}
                </a>
            );
        case "url": {
            const href = value as string;
            let shown = href;
            try {
                const url = new URL(href);
                shown = `${url.hostname.replace(/^www\./, "")}${url.pathname === "/" ? "" : url.pathname}`;
            } catch {
                // Stored by the normalizer, so always a URL; shown as is if not.
            }
            return <ExternalLink href={href}>{shown}</ExternalLink>;
        }
        case "domain":
            return <ExternalLink href={`https://${value as string}`}>{value as string}</ExternalLink>;
        case "select":
            return (
                <OptionChip
                    field={field}
                    option={value as string}
                    label={t(`options.${object}.${field.key}.${value as string}` as Parameters<typeof t>[0])}
                />
            );
        case "member":
            return <MemberLine value={value as Ref} />;
        case "relation":
            return <RefChip target={field.target!} value={value as Ref} />;
        case "number":
        case "currency":
            return (
                <span className="ml-auto truncate tabular-nums">{plainText(field, value, format, locale)}</span>
            );
        default: {
            const text = plainText(field, value, format, locale);
            return (
                <span className="truncate" title={text}>
                    {text}
                </span>
            );
        }
    }
}
