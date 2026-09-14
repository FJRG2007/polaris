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
 *
 * The second half of the same defect was a press rather than a frame: deleting an
 * email and reaching for the app switcher needed two goes. An action that moves
 * mail went through the router as well, AND revalidated Mail's layout - which
 * throws away every route payload the browser had prefetched, so the switcher had
 * nothing to navigate with. Neither is needed, because nothing the server draws
 * changes when a message moves: the list routes render no conversations (see
 * `list-page`), and the rail comes from its own endpoint. So both sides of that
 * are pinned here - the client path and the server one - since the cost of
 * getting either wrong is invisible on the screen that causes it.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const MAIL = `${SRC}app/(app)/mail/`;

const shell = await readFile(`${MAIL}mail-shell.tsx`, "utf8");
const actions = await readFile(`${MAIL}actions.ts`, "utf8");

/** One exported action's body, from its signature to the next export. */
function actionBody(source: string, name: string): string {
    const at = source.indexOf(`export async function ${name}(`);
    expect(at, `${name} is not in actions.ts`).toBeGreaterThan(-1);
    const rest = source.slice(at + 1);
    const next = rest.indexOf("\nexport ");
    return next === -1 ? rest : rest.slice(0, next);
}

/**
 * The actions that only move mail.
 *
 * Filing, reading, labelling, snoozing, sending, and throwing a draft away. Each
 * changes rows and counts and nothing the server renders, so none of them may
 * revalidate Mail's layout.
 */
const MOVES_MAIL = [
    "actOnAction",
    "setConversationStateAction",
    "moveAction",
    "moveToFolderAction",
    "emptyFolderAction",
    "snoozeAction",
    "applyLabelAction",
    "sendAction",
    "undoSendAction",
    "discardDraftAction"
];

/**
 * The actions that change the shape of a mailbox.
 *
 * A mailbox connected or removed, a folder made, renamed or coloured, a label
 * written, a rule added, a sync. These DO redraw the frame: the rail's endpoint
 * carries the mailboxes, the folders and the counts, and nothing else the layout
 * resolves - the labels and the sending identities come back only with the
 * server's own render.
 */
const CHANGES_THE_MAILBOX = [
    "addAccountAction",
    "removeAccountAction",
    "setFolderColorAction",
    "deleteFolderAction",
    "setFolderRoleAction",
    "createFolderForRoleAction",
    "createLabelAction",
    "renameLabelAction",
    "deleteLabelAction",
    "setSpamFilterAction",
    "forgetSpamAction",
    "trustSenderAction",
    "blockSenderAction",
    "unblockSenderAction",
    "unsubscribeAction",
    "unsubscribeFromMessageAction",
    "syncAccountAction",
    "syncAllAction"
];

describe("what a live frame does", () => {
    it("pulls the lists and the rail, and never the router", () => {
        const handler = shell.slice(shell.indexOf("const onFrame = useCallback"));
        const body = handler.slice(0, handler.indexOf("}, [refreshMailbox]);"));
        expect(body).toContain("refreshMailbox();");
        expect(body).not.toContain("router.refresh");
        // Nor through the wrapper that calls it.
        expect(body).not.toMatch(/(?<!pull|reload|Mailbox)refresh\(\)/);
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

describe("the one way mail that moved is drawn again", () => {
    it("is both halves of the screen, and never the router", () => {
        const pair = shell.slice(shell.indexOf("const refreshMailbox = useCallback"));
        const body = pair.slice(0, pair.indexOf("}, [pullRail, reloadLists]);"));
        expect(body).toContain("reloadLists();");
        expect(body).toContain("pullRail();");
        expect(body).not.toContain("router.refresh");
    });

    it("is on the context, so a frame and a press share one definition", () => {
        expect(shell).toContain("readonly refreshMailbox: () => void;");
        expect(shell).toContain("refreshMailbox,");
    });

    it("is what the screens that move mail actually call", async () => {
        // A conversation filed from inside it, pinned, labelled or marked read,
        // and a message sent or brought back. None of those may reach the router.
        for (const file of ["thread-view.tsx", "composer.tsx"]) {
            const source = await readFile(`${MAIL}${file}`, "utf8");
            expect(source, file).toContain("refreshMailbox()");
            expect(source, file).not.toContain("refresh()");
        }
        // The list keeps both: filing a message is mail moving, while a sync or a
        // block changes the mailbox itself.
        const view = await readFile(`${MAIL}mail-view.tsx`, "utf8");
        expect(view).toContain("refreshMailbox()");
        expect(view).toContain("refresh()");
    });
});

describe("what still goes through the router", () => {
    it("is the refresh an action asks for, which is a press rather than a frame", () => {
        const refresh = shell.slice(shell.indexOf("const refresh = useCallback"));
        expect(refresh.slice(0, refresh.indexOf("}, ["))).toContain("router.refresh();");
    });
});

describe("what the server is asked to redraw", () => {
    it("is never the layout for a message moving", () => {
        // `revalidatePath(MAIL_PATH, "layout")` invalidates every cached route
        // payload the browser holds, prefetches included. Doing that because an
        // email was deleted is what made the app switcher need a second press.
        const offenders = MOVES_MAIL.filter((name) =>
            actionBody(actions, name).includes("refresh();")
        );
        expect(offenders).toEqual([]);
    });

    it("is the layout whenever the shape of a mailbox changed", () => {
        // The other side of the rule, so this is not quietly satisfied by an
        // action that redraws nothing at all.
        const missing = CHANGES_THE_MAILBOX.filter(
            (name) => !actionBody(actions, name).includes("refresh();")
        );
        expect(missing).toEqual([]);
    });

    it("goes through the one helper, so there is a single place to read the rule", () => {
        expect(actions).toContain('revalidatePath(MAIL_PATH, "layout");');
        // Once, inside `refresh` - not sprinkled through the actions.
        expect(actions.match(/revalidatePath\(/g)).toHaveLength(1);
    });
});
