"use client";

/**
 * The network filter's own rules as a list, like the Firewall's: each rule's
 * shape as a chip, its value, its action, and edit and delete beside it. Each
 * change is saved on its own, shown at once and put back if the save fails.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import {
    Fragment,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode
} from "react";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    Select,
    shellScroller
} from "@polaris/ui";
import { editDnsRuleAction } from "./actions";
import * as rules from "@/lib/dns-blocker/rules";
import { useDnsBlocker } from "./dns-blocker-context";
import { useTranslations } from "@/components/i18n/i18n-provider";

type Rules = { allow: string[]; deny: string[] };
type Filter = "all" | rules.DnsRuleAction;
type Row = ReturnType<typeof rules.ruleRows>[number];

/** The dialog's state: adding, or editing the rule it was opened on. */
type Editing = { from: { action: rules.DnsRuleAction; rule: string } | null } | null;

export function DnsRulesEditor() {
    const t = useTranslations("dnsBlocker");
    const { saved, adoptRules } = useDnsBlocker();
    const [pending, setPending] = useState<Rules | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState<Filter>("all");
    const [editing, setEditing] = useState<Editing>(null);

    const current: Rules = pending ?? { allow: saved.allow, deny: saved.deny };
    const rows = useMemo(() => {
        const needle = search.trim().toLowerCase();
        return rules
            .ruleRows(current)
            .filter((row) => filter === "all" || row.action === filter)
            .filter((row) => !needle || row.rule.toLowerCase().includes(needle));
    }, [current, filter, search]);
    const total = current.allow.length + current.deny.length;

    /** Shown at once, saved, and put back when the save fails. */
    async function commit(edit: rules.DnsRuleEdit): Promise<string | null> {
        const next = rules.applyRuleEdit(current, edit);
        if (typeof next === "string") return t(`rules.refusal.${next}`);
        setPending(next);
        setError(null);
        const result = await editDnsRuleAction(edit);
        setPending(null);
        if (result.error !== undefined) {
            setError(result.error);
            return result.error;
        }
        adoptRules(result.settings);
        return null;
    }

    return (
        <Card>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <CardTitle>{t("rules.title")}</CardTitle>
                    <p className="text-xs text-muted-foreground">{t("rules.intro")}</p>
                </div>
                <Button size="sm" onClick={() => setEditing({ from: null })}>
                    <Plus className="size-4 shrink-0" aria-hidden />
                    {t("rules.add")}
                </Button>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                {total > 0 ? (
                    <div className="flex flex-col gap-2 sm:flex-row">
                        <div className="relative min-w-0 flex-1">
                            <Search
                                className="pointer-events-none absolute left-2 top-1/2 size-4 shrink-0 -translate-y-1/2 text-muted-foreground"
                                aria-hidden
                            />
                            <Input
                                className="pl-8"
                                value={search}
                                placeholder={t("rules.search")}
                                aria-label={t("rules.search")}
                                onChange={(event) => setSearch(event.target.value)}
                            />
                        </div>
                        <Select
                            className="w-full sm:w-40"
                            value={filter}
                            aria-label={t("rules.filter")}
                            onValueChange={(value) => setFilter(value as Filter)}
                            options={[
                                { value: "all", label: t("rules.filterAll") },
                                { value: "allow", label: t("rules.action.allow") },
                                { value: "deny", label: t("rules.action.deny") }
                            ]}
                        />
                    </div>
                ) : null}
                {error ? (
                    <p role="alert" className="text-xs text-danger">
                        {error}
                    </p>
                ) : null}
                {total === 0 ? (
                    <EmptyState bare title={t("rules.empty")} description={t("rules.emptyHint")} />
                ) : rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("rules.noMatch")}</p>
                ) : (
                    <RuleList
                        rows={rows}
                        label={t("rules.title")}
                        renderRow={(row, ref, index) => (
                            <li
                                ref={ref}
                                data-index={index}
                                className="flex min-w-0 items-center gap-2 py-2"
                            >
                                <Badge variant="neutral" className="shrink-0">
                                    {t(`rules.kind.${row.kind}`)}
                                </Badge>
                                <code
                                    className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
                                    title={row.rule}
                                >
                                    {row.rule}
                                </code>
                                <span
                                    className={
                                        row.action === "allow"
                                            ? "shrink-0 text-xs font-medium text-success"
                                            : "shrink-0 text-xs font-medium text-danger"
                                    }
                                >
                                    {t(`rules.action.${row.action}`)}
                                </span>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    aria-label={t("rules.edit", { rule: row.rule })}
                                    title={t("rules.edit", { rule: row.rule })}
                                    onClick={() => setEditing({ from: row })}
                                >
                                    <Pencil className="size-4 shrink-0" aria-hidden />
                                </Button>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    aria-label={t("rules.remove", { rule: row.rule })}
                                    title={t("rules.remove", { rule: row.rule })}
                                    onClick={() =>
                                        void commit({
                                            op: "delete",
                                            from: { action: row.action, rule: row.rule }
                                        })
                                    }
                                >
                                    <Trash2 className="size-4 shrink-0" aria-hidden />
                                </Button>
                            </li>
                        )}
                    />
                )}
            </CardBody>
            {editing ? (
                <RuleDialog
                    from={editing.from}
                    onClose={() => setEditing(null)}
                    onSubmit={async (next) =>
                        commit(
                            editing.from
                                ? { op: "edit", from: editing.from, next }
                                : { op: "add", next }
                        )
                    }
                />
            ) : null}
        </Card>
    );
}

/** useLayoutEffect, without the warning a server render gives for it. */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** The rules, drawing only the ones on screen: windowed against the shell's
 *  content area, offset by where the list starts inside it, with the room of
 *  the rows not drawn kept above and below. */
function RuleList({
    rows,
    label,
    renderRow
}: {
    rows: readonly Row[];
    label: string;
    renderRow: (row: Row, ref: (node: Element | null) => void, index: number) => ReactNode;
}) {
    const list = useRef<HTMLUListElement>(null);
    const [margin, setMargin] = useState(0);

    useIsomorphicLayoutEffect(() => {
        const measure = () => {
            const element = list.current;
            const scroller = element ? shellScroller(element) : null;
            if (!element || !scroller) return;
            const top = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
            setMargin(top + scroller.scrollTop);
        };
        measure();
        window.addEventListener("resize", measure);
        return () => window.removeEventListener("resize", measure);
    }, []);

    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => (list.current ? shellScroller(list.current) : null),
        estimateSize: () => 45,
        overscan: 8,
        scrollMargin: margin,
        getItemKey: (index) => `${rows[index]!.action}:${rows[index]!.rule}`,
        initialRect: { width: 1280, height: 1000 }
    });
    const drawn = virtualizer.getVirtualItems();
    const last = drawn[drawn.length - 1];
    const above = drawn[0] ? drawn[0].start - margin : 0;
    const below = last ? virtualizer.getTotalSize() - (last.end - margin) : 0;

    return (
        <ul ref={list} className="flex flex-col divide-y divide-border" aria-label={label}>
            {above > 0 ? <li aria-hidden="true" style={{ height: above }} /> : null}
            {drawn.map((item) => (
                <Fragment key={item.key}>
                    {renderRow(rows[item.index]!, virtualizer.measureElement, item.index)}
                </Fragment>
            ))}
            {below > 0 ? <li aria-hidden="true" style={{ height: below }} /> : null}
        </ul>
    );
}

/** Adding or editing one rule, checked as it is typed against the schema the
 *  server checks it with. */
export function RuleDialog({
    from,
    onClose,
    onSubmit
}: {
    from: { action: rules.DnsRuleAction; rule: string } | null;
    onClose: () => void;
    onSubmit: (next: { action: rules.DnsRuleAction; rule: string }) => Promise<string | null>;
}) {
    const t = useTranslations("dnsBlocker");
    const [action, setAction] = useState<rules.DnsRuleAction>(from?.action ?? "deny");
    const [text, setText] = useState(from?.rule ?? "");
    const [refusal, setRefusal] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const parsed = rules.dnsRuleInputSchema.safeParse({ action, rule: text });
    // An empty field is unfinished, not wrong.
    const incomplete = text.trim().length === 0;
    const invalid = !incomplete && !parsed.success;

    async function submit() {
        if (!parsed.success || busy) return;
        setBusy(true);
        const failure = await onSubmit(parsed.data);
        setBusy(false);
        if (failure) setRefusal(failure);
        else onClose();
    }

    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{from ? t("rules.editTitle") : t("rules.addTitle")}</DialogTitle>
                    <DialogDescription>{t("rules.syntax")}</DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void submit();
                    }}
                >
                    <label className="flex flex-col gap-1 text-sm">
                        <span>{t("rules.actionLabel")}</span>
                        <Select
                            value={action}
                            aria-label={t("rules.actionLabel")}
                            onValueChange={(value) => setAction(value as rules.DnsRuleAction)}
                            options={[
                                { value: "deny", label: t("rules.action.deny") },
                                { value: "allow", label: t("rules.action.allow") }
                            ]}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span>
                            {t("rules.value")} <span aria-hidden>*</span>
                        </span>
                        <Input
                            value={text}
                            autoFocus
                            spellCheck={false}
                            className="font-mono text-xs"
                            placeholder="ads.example.com"
                            aria-invalid={invalid}
                            onChange={(event) => {
                                setText(event.target.value);
                                setRefusal(null);
                            }}
                        />
                        {invalid ? (
                            <span className="text-xs text-danger">
                                {t("validation.invalidRule")}
                            </span>
                        ) : parsed.success ? (
                            <span className="text-xs text-muted-foreground">
                                {t("rules.detected", {
                                    kind: t(`rules.kind.${rules.ruleKind(parsed.data.rule)}`)
                                })}
                            </span>
                        ) : null}
                        {refusal ? (
                            <span role="alert" className="text-xs text-danger">
                                {refusal}
                            </span>
                        ) : null}
                    </label>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {t("rules.cancel")}
                        </Button>
                        <Button type="submit" aria-disabled={!parsed.success || busy}>
                            {from ? t("rules.saveRule") : t("rules.addRule")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
