/**
 * A screen that lists records adds a new one through ONE header button ("Add
 * host", "Add passkey", "New key") that opens a dialog holding the form - the
 * way Account > API keys does it - never an inline add form under or above the
 * list.
 *
 * The signal, per `.tsx` file that draws a list (`<table`, `<ul`, `<tbody` or a
 * `.map(`): an add control - a `<Plus` icon or a `t("....add...")`,
 * `t("....create...")`, `t("....new...")` label - on a `<Button` outside any
 * dialog, sheet, popover or menu content, with a text field (`Input`,
 * `PhoneInput`, `Textarea`, or a `...Fields` component) in the 30 lines before
 * that button, also outside them. A field that is a search or a filter (its tag
 * mentions search, find, filter or match) is the toolbar API keys has, not an
 * add form, and is skipped. It is a heuristic: it errs toward flagging.
 *
 * Every screen has been converted, so this is a hard rule: any site fails. The
 * only files below are ones the heuristic cannot tell apart - a form that is
 * already inside a dialog drawn by another component, or a multi-value field
 * that is not a list of records - each with its exact count and why. Nothing
 * may be listed as still to convert.
 */

import { describe, expect, it } from "vitest";
import { join, relative, resolve } from "node:path";
import { readdirSync, readFileSync } from "node:fs";

const APPS = resolve(import.meta.dirname, "../../..");
const ROOTS = [join(APPS, "web", "src"), join(APPS, "..", "packages", "ui", "src")];

/** Sites that are not inline add forms, by path under `apps/`, with the exact count. */
const KNOWN: Record<string, { count: number; why: string }> = {
    "web/src/app/(app)/admin/domains/setup-wizard.tsx": { count: 1, why: "a setup wizard step, not a list screen" },
    "web/src/app/(app)/analytics/sites/new/add-site-flow.tsx": { count: 1, why: "a creation page of its own" },
    "web/src/app/(app)/apps/deploy/deploy-view.tsx": { count: 1, why: "the database form of the New service dialog, drawn in a component of its own" },
    "web/src/app/(app)/apps/deploy/variable-groups.tsx": { count: 1, why: "inside the variable groups dialog: New group swaps the form in for the list, one modal at a time" },
    "web/src/app/(app)/automations/code-review/repo-schedules-section.tsx": { count: 1, why: "inside the repository dialog: the form swaps in for the list, one modal at a time" },
    "web/src/app/(app)/automations/[id]/alert-fields.tsx": { count: 1, why: "one generated address inside an automation form" },
    "web/src/app/(app)/automations/[id]/flow-fields.tsx": { count: 1, why: "value rows inside an automation step form" },
    "web/src/app/(app)/automations/[id]/polar-fields.tsx": { count: 2, why: "outcome and field rows inside an automation step form" },
    "web/src/app/(app)/automations/[id]/webhook-fields.tsx": { count: 1, why: "limit rows inside an automation step form" },
    "web/src/app/(app)/office/c/[id]/comparison-editor.tsx": { count: 2, why: "columns of a document being edited, not records" },
    "web/src/app/(app)/tasks/planning-view.tsx": { count: 2, why: "quick-add inside a task board, the task-app standard" },
    "web/src/app/(app)/tasks/space-view.tsx": { count: 3, why: "quick-add inside a task board, the task-app standard" },
    "web/src/app/(app)/tasks/task-subwork.tsx": { count: 1, why: "quick-add of sub-work inside one task, the task-app standard" },
    "web/src/components/agents/review-output-fields.tsx": { count: 1, why: "output rows inside an agent form" },
    "web/src/components/rule-list-input.tsx": { count: 1, why: "a multi-value form field" },
    "web/src/components/rules/chip-list.tsx": { count: 1, why: "a multi-value form field" },
    "web/src/components/rules/value-pickers.tsx": { count: 1, why: "a multi-value form field" },
};

const OVERLAY = /<(DialogContent|SheetContent|PopoverContent|AlertDialogContent|DropdownMenuContent)\b/g;
const OVERLAY_END = /<\/(DialogContent|SheetContent|PopoverContent|AlertDialogContent|DropdownMenuContent)>/g;
const ADD = /<Plus\b|t\("[\w.]*\.(add|create|new)(?![a-z])\w*"\)|t\("[\w.]*(Add|Create)(?![a-z])\w*"\)/;
const FIELD = /<(Input|PhoneInput|Textarea|[A-Z]\w*Fields)\b/;
const LOOKUP = /search|find|filter|match/i;
const LIST = /<table\b|<ul\b|<tbody\b|\.map\(/;

/** How many add buttons in a file sit beside an inline field instead of opening a dialog. */
function inlineAddForms(source: string): number {
    if (!LIST.test(source)) return 0;
    const lines = source.split("\n");
    let depth = 0;
    const covered = lines.map((line) => {
        const before = depth;
        depth += (line.match(OVERLAY) ?? []).length;
        depth -= (line.match(OVERLAY_END) ?? []).length;
        return before > 0 || depth > 0;
    });
    const buttons = new Set<number>();
    lines.forEach((line, at) => {
        if (covered[at] || !ADD.test(line)) return;
        let button = -1;
        for (let k = at; k >= Math.max(0, at - 20); k--) {
            if (/<Button\b/.test(lines[k])) {
                button = k;
                break;
            }
        }
        if (button < 0 || covered[button]) return;
        let field = -1;
        for (let k = button - 1; k >= Math.max(0, button - 30); k--) {
            if (FIELD.test(lines[k])) {
                field = k;
                break;
            }
        }
        if (field < 0 || covered[field]) return;
        if (LOOKUP.test(lines.slice(field, field + 8).join("\n"))) return;
        buttons.add(button);
    });
    return buttons.size;
}

function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== "node_modules") sources(path, out);
        } else if (path.endsWith(".tsx") && !/\.(test|stories)\.tsx$/.test(path)) out.push(path);
    }
    return out;
}

const counts = new Map<string, number>();
for (const root of ROOTS) {
    for (const file of sources(root)) {
        const count = inlineAddForms(readFileSync(file, "utf8"));
        if (count > 0) counts.set(relative(APPS, file).replaceAll("\\", "/"), count);
    }
}

const INLINE = `
export function List({ rows }) {
    return (
        <div>
            <ul>{rows.map((row) => <li key={row}>{row}</li>)}</ul>
            <form>
                <Input value={name} placeholder={t("x.namePlaceholder")} />
                <Button type="submit">
                    <Plus className="size-4" />
                    {t("x.add")}
                </Button>
            </form>
        </div>
    );
}`;

const HEADER = `
export function List({ rows }) {
    return (
        <div>
            <Input value={query} placeholder={t("x.search")} />
            <Button onClick={() => setOpen(true)}>
                <Plus className="size-4" />
                {t("x.addThing")}
            </Button>
            <ul>{rows.map((row) => <li key={row}>{row}</li>)}</ul>
            <Dialog open={open}>
                <DialogContent>
                    <Input value={name} />
                    <Button type="submit">{t("x.add")}</Button>
                </DialogContent>
            </Dialog>
        </div>
    );
}`;

describe("adding to a list", () => {
    it("tells an inline add form from a header button and a dialog", () => {
        expect(inlineAddForms(INLINE)).toBe(1);
        expect(inlineAddForms(HEADER)).toBe(0);
        expect(counts.size).toBeGreaterThan(0);
    });

    it("adds through a header button and a dialog, never an inline form beside the list", () => {
        const offenders = [...counts]
            .filter(([file, count]) => count !== KNOWN[file]?.count)
            .map(([file, count]) => `${file}: ${count} (listed: ${KNOWN[file]?.count ?? 0})`);
        expect(offenders).toEqual([]);
    });

    it("lists only files that still have a site", () => {
        expect(Object.keys(KNOWN).filter((file) => !counts.has(file))).toEqual([]);
    });

    it("leaves nothing listed as still to convert", () => {
        expect(Object.entries(KNOWN).filter(([, entry]) => /pending|convert/i.test(entry.why))).toEqual([]);
    });
});
