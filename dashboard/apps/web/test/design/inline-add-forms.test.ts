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
 * add form, and is skipped. It is a heuristic: it errs toward flagging, and
 * each file it flags is listed below with how many and why.
 *
 * The list is a ratchet. A new file, or more sites in a listed one, fails; so
 * does a listed file with fewer, so the entry is lowered as each is converted.
 * Entries marked PENDING are the ones still to convert.
 */

import { describe, expect, it } from "vitest";
import { join, relative, resolve } from "node:path";
import { readdirSync, readFileSync } from "node:fs";

const APPS = resolve(import.meta.dirname, "../../..");
const ROOTS = [join(APPS, "web", "src"), join(APPS, "..", "packages", "ui", "src")];

/** Files allowed to keep a site, by path under `apps/`, with the exact count. */
const KNOWN: Record<string, { count: number; why: string }> = {
    "web/src/app/(app)/account/friends/friends-view.tsx": { count: 1, why: "PENDING: convert to a header button and a dialog" },
    "web/src/app/(app)/account/organizations/[slug]/people/people-view.tsx": { count: 1, why: "PENDING: convert to a header button and a dialog" },
    "web/src/app/(app)/account/privacy/activity-sharing-card.tsx": { count: 1, why: "PENDING: convert to a header button and a dialog" },
    "web/src/app/(app)/admin/domains/domains-view.tsx": { count: 1, why: "PENDING: convert to a header button and a dialog" },
    "web/src/app/(app)/admin/domains/setup-wizard.tsx": { count: 1, why: "a setup wizard step, not a list screen" },
    "web/src/app/(app)/admin/uploads/network-card.tsx": { count: 1, why: "PENDING: convert to a header button and a dialog" },
    "web/src/app/(app)/analytics/annotations.tsx": { count: 2, why: "PENDING: convert to a header button and a dialog" },
    "web/src/app/(app)/analytics/sites/new/add-site-flow.tsx": { count: 1, why: "a creation page of its own" },
    "web/src/app/(app)/apps/backups/keys-panel.tsx": { count: 1, why: "PENDING: convert to a header button and a dialog" },
    "web/src/app/(app)/apps/deploy/database-accounts-panel.tsx": { count: 1, why: "PENDING: convert to a header button and a dialog" },
    "web/src/app/(app)/apps/deploy/database-panel.tsx": { count: 3, why: "PENDING: convert to a header button and a dialog" },
    "web/src/app/(app)/apps/deploy/deploy-view.tsx": { count: 1, why: "PENDING: convert to a header button and a dialog" },
    "web/src/app/(app)/apps/deploy/private-network-panel.tsx": { count: 1, why: "PENDING: convert to a header button and a dialog" },
    "web/src/app/(app)/apps/deploy/variable-groups.tsx": { count: 2, why: "PENDING: convert to a header button and a dialog" },
    "web/src/app/(app)/apps/servers/server-groups.tsx": { count: 1, why: "PENDING: convert to a header button and a dialog" },
    "web/src/app/(app)/automations/code-review/repo-schedules-section.tsx": { count: 2, why: "PENDING: convert to a header button and a dialog" },
    "web/src/app/(app)/automations/[id]/alert-fields.tsx": { count: 1, why: "one generated address inside an automation form" },
    "web/src/app/(app)/automations/[id]/flow-fields.tsx": { count: 1, why: "value rows inside an automation step form" },
    "web/src/app/(app)/automations/[id]/polar-fields.tsx": { count: 2, why: "outcome and field rows inside an automation step form" },
    "web/src/app/(app)/automations/[id]/webhook-fields.tsx": { count: 1, why: "limit rows inside an automation step form" },
    "web/src/app/(app)/chat/forum-settings.tsx": { count: 1, why: "PENDING: convert to a header button and a dialog" },
    "web/src/app/(app)/mail/settings/labels/labels-view.tsx": { count: 1, why: "PENDING: convert to a header button and a dialog" },
    "web/src/app/(app)/network-filter/devices-section.tsx": { count: 1, why: "PENDING: convert to a header button and a dialog" },
    "web/src/app/(app)/network-filter/lists-section.tsx": { count: 1, why: "PENDING: convert to a header button and a dialog" },
    "web/src/app/(app)/network-filter/local-dns-section.tsx": { count: 3, why: "PENDING: convert to a header button and a dialog" },
    "web/src/app/(app)/office/c/[id]/comparison-editor.tsx": { count: 2, why: "columns of a document being edited, not records" },
    "web/src/app/(app)/tasks/planning-view.tsx": { count: 2, why: "quick-add inside a task board, the task-app standard" },
    "web/src/app/(app)/tasks/space-view.tsx": { count: 3, why: "quick-add inside a task board, the task-app standard" },
    "web/src/app/(app)/tasks/task-subwork.tsx": { count: 1, why: "quick-add of sub-work inside one task, the task-app standard" },
    "web/src/app/(app)/vault/sends/sends-view.tsx": { count: 1, why: "PENDING: convert to a header button and a dialog" },
    "web/src/app/(app)/vault/vaults/vaults-view.tsx": { count: 2, why: "PENDING: convert to a header button and a dialog" },
    "web/src/components/agents/review-output-fields.tsx": { count: 1, why: "output rows inside an agent form" },
    "web/src/components/owner-domains-view.tsx": { count: 1, why: "PENDING: convert to a header button and a dialog" },
    "web/src/components/project-webhooks.tsx": { count: 1, why: "PENDING: convert to a header button and a dialog" },
    "web/src/components/rule-list-input.tsx": { count: 1, why: "a multi-value form field" },
    "web/src/components/rules/chip-list.tsx": { count: 1, why: "a multi-value form field" },
    "web/src/components/rules/value-pickers.tsx": { count: 1, why: "a multi-value form field" },
};

const OVERLAY = /<(DialogContent|SheetContent|PopoverContent|AlertDialogContent|DropdownMenuContent)\b/g;
const OVERLAY_END = /<\/(DialogContent|SheetContent|PopoverContent|AlertDialogContent|DropdownMenuContent)>/g;
const ADD = /<Plus\b|t\("[\w.]*\.(add|create|new)\w*"\)|t\("[\w.]*(Add|Create)\w*"\)/;
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
});
