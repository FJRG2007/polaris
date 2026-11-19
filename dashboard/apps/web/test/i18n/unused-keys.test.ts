/**
 * Every catalog key is read by something.
 *
 * A key nothing reads is a sentence translated into every language for no
 * screen, and the catalogs only grow: a string replaced on a screen used to
 * stay behind in every locale. A key that is no longer read is deleted from
 * every language in the same change that stopped reading it.
 *
 * The dashboard's catalogs are the host's, so any app and any shared package
 * may read them; an app's own catalogs are read by that app.
 */

import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { isRead, sourceStrings, stringsOf, templatePattern, unusedKeys } from "./unused-keys";

const DASHBOARD = resolve(__dirname, "../../../..");
const APPS = join(DASHBOARD, "apps");
const PACKAGES = join(DASHBOARD, "packages");

describe("the unused-key scan", () => {
    const strings = (source: string) => {
        const into = { literals: new Set<string>(), patterns: [] as RegExp[] };
        stringsOf(source, into);
        return into;
    };

    it("reads a key named whole, with or without its namespace", () => {
        const found = strings(`t("share.title"); const k = "chat.callRoom.stop";`);
        expect(isRead("chat", "share.title", found)).toBe(true);
        expect(isRead("chat", "callRoom.stop", found)).toBe(true);
        expect(isRead("chat", "callRoom.start", found)).toBe(false);
    });

    it("reads every key a template fits, and none it does not", () => {
        const found = strings("t(`levels.${level}`); t(`modes.${mode}.hint`);");
        expect(isRead("badges", "levels.spark", found)).toBe(true);
        expect(isRead("chat", "modes.gaming.hint", found)).toBe(true);
        expect(isRead("chat", "modes.gaming.name", found)).toBe(false);
        expect(isRead("badges", "units.days", found)).toBe(false);
    });

    it("reads a key named as a scope and the rest under it", () => {
        const found = strings(`const t = useTranslations("agents.session"); t("send"); t(\`views.\${view}\`);`);
        expect(isRead("agents", "session.send", found)).toBe(true);
        expect(isRead("agents", "session.views.terminal", found)).toBe(true);
        expect(isRead("agents", "sessions.send", found)).toBe(false);
    });

    it("reads a template inside another template's hole", () => {
        const found = strings("const line = `${result ? ` - ${t(`queue.results.${result}`)}` : \"\"}`;");
        expect(isRead("agentRollouts", "queue.results.offline", found)).toBe(true);
    });

    it("reads a template whose prefix is a constant of the same file", () => {
        const found = strings('const ISSUE = "view.issues"; issue(`${ISSUE}.${code}`);');
        expect(isRead("deploy", "view.issues.urlAmqp", found)).toBe(true);
        expect(isRead("deploy", "view.other.urlAmqp", found)).toBe(false);
    });

    it("reads a label keyed by its English", () => {
        expect(isRead("nav", "labels.Wall panels", strings("t(`labels.${english}`)"))).toBe(true);
    });

    it("ignores a template whose fixed parts point at nothing", () => {
        expect(templatePattern(["", ".", ""])).toBeNull();
        expect(templatePattern(["plain"])).toBeNull();
    });
});

/**
 * Catalog branches read whole, as a table, by a name the source never spells
 * as a key: `mcp.tools.<tool>` is looked up by each tool's registered name
 * (`lib/mcp/abilities.ts`).
 */
const READ_AS_DATA = ["mcp.tools."];

describe("every catalog key is read", () => {
    const shared = [
        ...readdirSync(APPS).map((app) => join(APPS, app)),
        ...readdirSync(PACKAGES).map((name) => join(PACKAGES, name))
    ];
    const catalogs = readdirSync(APPS)
        .map((app) => ({ app, folder: join(APPS, app, "messages", "en-US") }))
        .filter(({ folder }) => existsSync(folder));

    it.each(catalogs)("in $app", ({ app, folder }) => {
        const roots = app === "web" ? shared : [join(APPS, app)];
        const unused = unusedKeys(folder, sourceStrings(roots));
        expect(unused.filter((key) => !READ_AS_DATA.some((prefix) => key.startsWith(prefix)))).toEqual([]);
    }, 180_000);
});
