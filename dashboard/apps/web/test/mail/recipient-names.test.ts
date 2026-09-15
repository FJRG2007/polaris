/**
 * Who the people on a message are called.
 *
 * A `To` or `Cc` header usually carries bare addresses: the client that sent it
 * had no reason to write anybody's name into it. Shown as they arrived, the line
 * under the subject read as a row of usernames - the part before the `@` - for
 * people the reader writes to every day and whose names are on the screen right
 * behind it, taken from the `From` of their own messages.
 *
 * So the names are filled in from the address book this mailbox keeps on its own.
 * What is asserted here is the boundary of that: filled in where it is known,
 * left alone where the header said something, and never invented where nobody has
 * ever been told.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface ContactRow {
    address: string;
    name: string;
    sentCount: number;
    receivedCount: number;
}

/** The address book, as the query would find it. */
let contacts: ContactRow[] = [];

/** The one conversation being read. */
let message: Record<string, unknown> = {};

vi.mock("@polaris/db", () => ({
    prisma: {
        mailMessage: { findMany: async () => [message] },
        mailContact: { findMany: async () => contacts }
    }
}));

vi.mock("@/lib/mailbox/access", () => ({ unifiedAccountIds: async () => [] }));

const { readThread } = await import("@/lib/mailbox/views");

const ACCOUNT = "0190c1d2-0000-7000-8000-000000000001";
const READER = "0190c1d2-0000-7000-8000-000000000002";
const THREAD = "0190c1d2-0000-7000-8000-0000000000f0";

/** A message as the column holds it: addresses, and whatever names came with. */
function stored(to: { name: string; address: string }[], cc: { name: string; address: string }[]) {
    return {
        id: "0190c1d2-0000-7000-8000-0000000000e1",
        accountId: ACCOUNT,
        folderId: "0190c1d2-0000-7000-8000-0000000000d1",
        subject: "The quarter",
        fromJson: [{ name: "Ada", address: "ada@example.test" }],
        toJson: to,
        ccJson: cc,
        replyToJson: [],
        snippet: "",
        sentAt: new Date("2026-01-02T10:00:00.000Z"),
        seen: true,
        flagged: false,
        important: false,
        answered: false,
        wantsReceipt: false,
        listId: "",
        spamScore: null,
        spamReason: "",
        folder: { role: "inbox" },
        attachments: []
    };
}

beforeEach(() => {
    contacts = [];
    message = stored([{ name: "", address: "ana@example.test" }], []);
});

describe("a recipient the header did not name", () => {
    it("is called what this mailbox already knows them as", async () => {
        // The reported one: the header carried the address alone, and the screen
        // showed the part before the `@` as though it were a name.
        contacts = [{ address: "ana@example.test", name: "Ana Serrano", sentCount: 3, receivedCount: 1 }];

        const [read] = await readThread(READER, THREAD);
        expect(read?.to[0]?.name).toBe("Ana Serrano");
        expect(read?.to[0]?.address).toBe("ana@example.test");
    });

    it("keeps the address and gains nothing when nobody has ever been told", async () => {
        // The half that matters as much: an address the address book has never
        // seen keeps its address. Anything made up out of the address itself
        // reads as a name and is not one.
        const [read] = await readThread(READER, THREAD);
        expect(read?.to[0]?.name).toBe("");
        expect(read?.to[0]?.address).toBe("ana@example.test");
    });

    it("is matched however either side was capitalised", async () => {
        message = stored([{ name: "", address: "Ana@Example.TEST" }], []);
        contacts = [{ address: "ana@example.test", name: "Ana Serrano", sentCount: 1, receivedCount: 0 }];

        const [read] = await readThread(READER, THREAD);
        expect(read?.to[0]?.name).toBe("Ana Serrano");
    });
});

describe("a recipient the header did name", () => {
    it("is left exactly as it arrived", async () => {
        // What the sender wrote is what this message says, and the address book
        // is a fallback rather than a correction.
        message = stored([{ name: "Written In", address: "ana@example.test" }], []);
        contacts = [{ address: "ana@example.test", name: "Ana Serrano", sentCount: 9, receivedCount: 9 }];

        const [read] = await readThread(READER, THREAD);
        expect(read?.to[0]?.name).toBe("Written In");
    });
});

describe("the same person known to two mailboxes", () => {
    it("is called what the mailbox that corresponds with them calls them", async () => {
        // One person, two address books, two names. The one that has actually
        // written to them wins, ranked the way completion ranks them, so two
        // screens never disagree about who somebody is.
        message = stored([], [{ name: "", address: "ana@example.test" }]);
        contacts = [
            { address: "ana@example.test", name: "A. Serrano", sentCount: 0, receivedCount: 1 },
            { address: "ana@example.test", name: "Ana Serrano", sentCount: 4, receivedCount: 0 }
        ];

        const [read] = await readThread(READER, THREAD);
        expect(read?.cc[0]?.name).toBe("Ana Serrano");
    });
});
