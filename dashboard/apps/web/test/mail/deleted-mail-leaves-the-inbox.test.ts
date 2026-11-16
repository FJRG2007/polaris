/**
 * Mail deleted somewhere else leaves the inbox here, however much of it is held.
 *
 * Reported on 2026-11-16 as "in the inbox I'm seeing emails I deleted
 * yesterday". The sync kept the newest 400 rows of a folder honest and nothing
 * else, but scrolling a list to its end brings older mail down as well - the
 * live inboxes held 733 and 815 rows - so anything older than the newest 400
 * that was deleted on a phone or in the provider's webmail stayed on screen for
 * ever. Reproduced against a fake server that behaves like Gmail: labels rather
 * than folders, `\Trash` and `\All` marked with SPECIAL-USE under Spanish names,
 * and a move to the trash that takes the message out of every other folder.
 *
 * And a mailbox whose sign-in was refused says so when somebody tries to change
 * its mail, instead of trying a login that is known to fail.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    folderId: string;
    uid: bigint;
}

const db = vi.hoisted(() => ({ rows: [] as Row[] }));

vi.mock("@polaris/db", () => ({
    prisma: {
        mailMessage: {
            findMany: vi.fn(
                async (query: {
                    where: { folderId: string; uid?: { lt: bigint } };
                    take: number;
                }) =>
                    db.rows
                        .filter((row) => row.folderId === query.where.folderId)
                        .filter((row) => !query.where.uid || row.uid < query.where.uid.lt)
                        .sort((left, right) => (left.uid < right.uid ? 1 : -1))
                        .slice(0, query.take)
                        .map((row) => ({ id: row.id, uid: row.uid }))
            ),
            deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
                const gone = new Set(where.id.in);
                const before = db.rows.length;
                db.rows = db.rows.filter((row) => !gone.has(row.id));
                return { count: before - db.rows.length };
            })
        }
    }
}));

import { RECONCILE_PAGE, reconcileDeletions } from "@/lib/mailbox/reconcile-deletions";
import {
    hearRefusal,
    lastRefusal,
    MailAccountSignedOut,
    refusalCode,
    refuseWhileSignedOut
} from "@/lib/mailbox/action-refusal";

/** Gmail, as IMAP sees it: one message, several labels, a uid per folder. */
class FakeGmail {
    public static readonly INBOX = "INBOX";

    public static readonly ALL = "[Gmail]/Todos";

    public static readonly TRASH = "[Gmail]/Papelera";

    private readonly messages: { labels: Set<string>; uids: Map<string, number> }[] = [];

    private readonly next = new Map<string, number>();

    public refuseSearch = false;

    public deliver(count: number): void {
        for (let at = 0; at < count; at += 1) {
            const message = { labels: new Set([FakeGmail.INBOX]), uids: new Map<string, number>() };
            this.messages.push(message);
            this.enter(message, FakeGmail.INBOX);
            this.enter(message, FakeGmail.ALL);
        }
    }

    /** Deleted in Gmail's own app: every label goes, Trash is the only one left. */
    public trashFromPhone(path: string, uid: number): void {
        const message = this.messages.find((one) => one.uids.get(path) === uid);
        if (!message) throw new Error(`no uid ${uid} in ${path}`);
        message.labels.clear();
        message.uids.clear();
        message.labels.add(FakeGmail.TRASH);
        this.enter(message, FakeGmail.TRASH);
    }

    /** The commands `reconcileDeletions` sends, on a session with `path` open. */
    public session(path: string) {
        const uidsIn = () =>
            this.messages.flatMap((one) => {
                const uid = one.uids.get(path);
                return uid === undefined ? [] : [uid];
            });
        return {
            search: vi.fn(async (query: { uid: string }) => {
                if (this.refuseSearch) return false as const;
                const [low, high] = query.uid.split(":");
                const top = high === "*" ? Number.MAX_SAFE_INTEGER : Number(high);
                return uidsIn().filter((uid) => uid >= Number(low) && uid <= top);
            }),
            fetch: vi.fn(async function* (range: string) {
                const asked = new Set(range.split(",").map(Number));
                for (const uid of uidsIn()) if (asked.has(uid)) yield { uid };
            })
        };
    }

    private enter(message: { uids: Map<string, number> }, path: string): void {
        const uid = (this.next.get(path) ?? 0) + 1;
        this.next.set(path, uid);
        message.uids.set(path, uid);
    }
}

/** Every message of a folder held here, as a list scrolled to its end leaves it. */
function holdAll(folderId: string, count: number): void {
    for (let uid = 1; uid <= count; uid += 1) {
        db.rows.push({ id: `${folderId}-${uid}`, folderId, uid: BigInt(uid) });
    }
}

function held(folderId: string): number[] {
    return db.rows.filter((row) => row.folderId === folderId).map((row) => Number(row.uid));
}

type Session = Parameters<typeof reconcileDeletions>[0];

describe("mail deleted in the provider's own app", () => {
    beforeEach(() => {
        db.rows = [];
    });

    it("leaves the inbox even when it is older than the newest 400 held", async () => {
        const gmail = new FakeGmail();
        gmail.deliver(815);
        holdAll("inbox", 815);
        gmail.trashFromPhone(FakeGmail.INBOX, 3);
        gmail.trashFromPhone(FakeGmail.INBOX, 800);

        const dropped = await reconcileDeletions(
            gmail.session(FakeGmail.INBOX) as unknown as Session,
            { id: "inbox" }
        );

        expect(dropped).toBe(2);
        expect(held("inbox")).toHaveLength(813);
        expect(held("inbox")).not.toContain(3);
        expect(held("inbox")).not.toContain(800);
    });

    it("leaves All Mail as well, under its localized name", async () => {
        const gmail = new FakeGmail();
        gmail.deliver(820);
        holdAll("all", 820);
        gmail.trashFromPhone(FakeGmail.ALL, 10);

        await reconcileDeletions(gmail.session(FakeGmail.ALL) as unknown as Session, {
            id: "all"
        });

        expect(held("all")).toHaveLength(819);
        expect(held("all")).not.toContain(10);
    });

    it("walks a folder bigger than one page, page by page", async () => {
        const gmail = new FakeGmail();
        const count = RECONCILE_PAGE * 2 + 500;
        gmail.deliver(count);
        holdAll("inbox", count);
        for (const uid of [1, RECONCILE_PAGE + 7, count - 1]) {
            gmail.trashFromPhone(FakeGmail.INBOX, uid);
        }
        const session = gmail.session(FakeGmail.INBOX);

        expect(await reconcileDeletions(session as unknown as Session, { id: "inbox" })).toBe(3);
        expect(held("inbox")).toHaveLength(count - 3);
        expect(session.search).toHaveBeenCalledTimes(3);
    });

    it("drops nothing when the server will not answer the search", async () => {
        const gmail = new FakeGmail();
        gmail.deliver(50);
        holdAll("inbox", 50);
        gmail.trashFromPhone(FakeGmail.INBOX, 5);
        gmail.refuseSearch = true;

        await reconcileDeletions(gmail.session(FakeGmail.INBOX) as unknown as Session, {
            id: "inbox"
        });

        expect(held("inbox")).toHaveLength(50);
    });
});

describe("a refused move", () => {
    it("is read off the server's response code, whatever language its folders are in", () => {
        expect(refusalCode("OVERQUOTA", "Cuota superada")).toBe("quota");
        expect(refusalCode("TRYCREATE", "")).toBe("folderGone");
        expect(refusalCode("NONEXISTENT", "")).toBe("folderGone");
        expect(refusalCode("NOPERM", "")).toBe("readOnly");
        expect(refusalCode("LIMIT", "")).toBe("limit");
        expect(refusalCode("", "Mailbox is full")).toBe("quota");
        expect(refusalCode("", "Something else")).toBe("server");
    });

    it("keeps what imapflow logged for the connection that was refused", () => {
        const client = {};
        expect(lastRefusal(client)).toBe("server");
        hearRefusal(client, {
            msg: "Command failed",
            err: {
                responseText: "Quota exceeded",
                response: {
                    attributes: [
                        { type: "ATOM", value: "", section: [{ type: "ATOM", value: "OVERQUOTA" }] },
                        { type: "TEXT", value: "Quota exceeded" }
                    ]
                }
            }
        });
        expect(lastRefusal(client)).toBe("quota");
        expect(lastRefusal({})).toBe("server");
    });
});

describe("a mailbox whose sign-in was refused", () => {
    it("refuses the action before any connection is tried", () => {
        expect(() => refuseWhileSignedOut({ state: "auth" })).toThrow(MailAccountSignedOut);
        expect(() => refuseWhileSignedOut({ state: "ok" })).not.toThrow();
        expect(() => refuseWhileSignedOut({})).not.toThrow();
    });

    it("is checked by every action that moves or deletes mail", async () => {
        const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
        const messages = await readFile(`${SRC}lib/mailbox/messages.ts`, "utf8");
        const trash = await readFile(`${SRC}lib/mailbox/trash.ts`, "utf8");
        expect(messages.match(/refusal\.refuseWhileSignedOut\(account\)/g)).toHaveLength(2);
        expect(trash).toContain("refusal.refuseWhileSignedOut(account);");
        expect(messages).toContain('throw new refusal.MailActionRefused(refused[0] ?? "server");');
        expect(trash).toContain('throw new refusal.MailActionRefused(refused[0] ?? "server");');
    });
});
