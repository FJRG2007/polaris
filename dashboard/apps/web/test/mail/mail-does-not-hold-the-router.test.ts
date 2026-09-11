/**
 * Why clicking anything took a second while Mail was open.
 *
 * The rail - the mailboxes, their folders and the unread counts - is resolved in
 * Mail's layout on the server, so the only way to move a number in it was
 * `router.refresh()`. That re-runs the whole signed-in frame (every badge, the
 * presence, the notifications) and then this layout and the page inside it, and
 * a mailbox syncing announces itself several times a minute.
 *
 * A Next router that is fetching defers what somebody clicks next. So for as
 * long as somebody had Mail open, links and buttons anywhere in Polaris did
 * nothing, or did it a beat later, which is how it was reported.
 *
 * The live channel asks a small endpoint for those three things instead. The
 * router is left for what only the server can redraw, and that is always
 * something somebody pressed.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

const shell = await readFile(`${SRC}app/(app)/mail/mail-shell.tsx`, "utf8");

describe("what a live frame does", () => {
    it("pulls the lists and the rail, and never the router", () => {
        const handler = shell.slice(shell.indexOf("const onFrame = useCallback"));
        const body = handler.slice(0, handler.indexOf("}, [pullRail, reloadLists]);"));
        expect(body).toContain("reloadLists();");
        expect(body).toContain("pullRail();");
        expect(body).not.toContain("router.refresh");
        // Nor through the wrapper that calls it.
        expect(body).not.toMatch(/(?<!pull|reload)refresh\(\)/);
    });

    it("asks for the three things the rail draws and nothing else", async () => {
        const route = await readFile(`${SRC}app/api/mail/rail/route.ts`, "utf8");
        expect(route).toContain("listAccountViews(session.id, shelfOrgId)");
        expect(route).toContain("listFolders(session.id, shelfOrgId)");
        expect(route).toContain("unreadCounts(session.id, shelfOrgId)");
        // Somebody else's rail is not a thing this can be asked for, and a rail
        // holds one shelf at a time.
        expect(route).toContain('sessionCan(session, "mail.use")');
        expect(route).toContain("scopeOrgIdFor(session.id)");
    });

    it("validates what comes back rather than blanking the rail on a shape it does not know", () => {
        expect(shell).toContain("const parsed = railSchema.safeParse(body);");
        expect(shell).toContain("if (parsed.success) setRail(parsed.data);");
    });
});

describe("where the rail starts from", () => {
    it("is the server's own render, so the first paint is right", () => {
        expect(shell).toContain("const [rail, setRail] = useState({");
        expect(shell).toContain("accounts: sentAccounts, folders: sentFolders, unread: sentUnread");
    });

    it("takes the server's word again whenever it renders", () => {
        // A mailbox added, a label written, a shelf switched: what the server
        // says then is the truth this was standing in for.
        expect(shell).toContain("}, [sentAccounts, sentFolders, sentUnread]);");
    });
});

describe("what still goes through the router", () => {
    it("is the refresh an action asks for, which is a press rather than a frame", () => {
        const refresh = shell.slice(shell.indexOf("const refresh = useCallback"));
        expect(refresh.slice(0, refresh.indexOf("}, ["))).toContain("router.refresh();");
    });
});
