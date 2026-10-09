/**
 * Adding, renaming and removing a space's emoji, and the fifty slots.
 *
 * Only whoever runs the space - its owner or an administrator - may change the
 * list. A name is unique in the space ignoring case. Each list holds fifty, and
 * that ceiling holds when uploads race for the last slot: the count happens
 * while the space's row is held, so the second upload counts fifty and is
 * refused, and the file it already wrote is taken back off the disk.
 *
 * The row lock is Postgres's `SELECT ... FOR UPDATE`; here it is a lock in the
 * mock, which proves the service counts and writes inside the held section. The
 * real database lock is not exercised by this suite.
 */

import sharp from "sharp";
import { CUSTOM_EMOJI_SLOTS } from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SPACE = "0193b0f0-0000-7000-8000-0000000000aa";

interface Row {
    id: string;
    spaceId: string;
    name: string;
    nameKey: string;
    animated: boolean;
    connectionId: string | null;
    path: string;
    uploaderId: string | null;
    createdAt: Date;
}

let role: "owner" | "admin" | "member" | null = "owner";
let rows: Row[] = [];
let placed: string[] = [];
let removed: string[] = [];
let announced = 0;
/** The space row's lock: a chain every holder waits on. */
let lock: Promise<void> = Promise.resolve();

function seed(count: number, animated: boolean): void {
    for (let index = 0; index < count; index += 1) {
        rows.push({
            id: crypto.randomUUID(),
            spaceId: SPACE,
            name: `seed_${animated ? "a" : "s"}${index}`,
            nameKey: `seed_${animated ? "a" : "s"}${index}`,
            animated,
            connectionId: null,
            path: `polaris/chat-emoji/${SPACE}/seed${index}.png`,
            uploaderId: "ada",
            createdAt: new Date()
        });
    }
}

const viewOf = (row: Row) => ({ ...row, uploader: row.uploaderId ? { name: "Ada" } : null });

vi.mock("@/lib/chat/access", async (importActual) => {
    const actual = await importActual<typeof import("@/lib/chat/access")>();
    return {
        ...actual,
        spaceAccess: async () => role,
        requireSpace: async (_actor: unknown, _space: string, minimum = "member") => {
            if (!role) throw new actual.ChatAccessError({ key: "errors.notInSpace" });
            if (minimum === "admin" && role === "member") {
                throw new actual.ChatAccessError({ key: "errors.spaceAdminOnly" });
            }
            return role;
        }
    };
});

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_DB_PROVIDER: "postgresql" }) }));

vi.mock("@/lib/chat/live", () => ({
    publishChatChange: () => {
        announced += 1;
    }
}));

vi.mock("@/lib/storage-target", () => ({
    LOCAL_TARGET: "local",
    placeFile: async ({ path }: { path: string }) => {
        placed.push(path);
        return { targetId: "local" };
    },
    driverForTarget: async () => null
}));

vi.mock("@/lib/chat/attachments", () => ({
    CHAT_LOCAL_FOLDER: "chat",
    chatTarget: async () => ({ id: "local" }),
    readStored: async () => new Uint8Array([1, 2, 3]),
    removeStoredFiles: async (files: { path: string }[]) => {
        removed.push(...files.map((file) => file.path));
    }
}));

vi.mock("@polaris/db", () => {
    const unique = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    const table = {
        count: async ({ where }: { where: { spaceId: string; animated: boolean } }) => {
            const used = rows.filter(
                (row) => row.spaceId === where.spaceId && row.animated === where.animated
            ).length;
            // A pause between reading and writing, which is where an unlocked
            // pair of uploads would both have read forty-nine.
            await new Promise((resolve) => setTimeout(resolve, 30));
            return used;
        },
        create: async ({ data }: { data: Omit<Row, "id" | "createdAt"> }) => {
            if (rows.some((row) => row.spaceId === data.spaceId && row.nameKey === data.nameKey))
                throw unique();
            const row = { ...data, id: crypto.randomUUID(), createdAt: new Date() };
            rows.push(row);
            return viewOf(row);
        },
        findUnique: async ({ where }: { where: { id: string } }) =>
            rows.find((row) => row.id === where.id) ?? null,
        findMany: async () => rows.map(viewOf),
        update: async ({
            where,
            data
        }: {
            where: { id: string };
            data: { name: string; nameKey: string };
        }) => {
            const row = rows.find((one) => one.id === where.id)!;
            if (rows.some((one) => one.id !== row.id && one.nameKey === data.nameKey))
                throw unique();
            Object.assign(row, data);
            return viewOf(row);
        },
        delete: async ({ where }: { where: { id: string } }) => {
            rows = rows.filter((row) => row.id !== where.id);
            return {};
        }
    };
    const client = {
        chatSpaceEmoji: table,
        chatChannel: { findMany: async () => [{ id: "channel-1" }] },
        $transaction: async (run: (tx: unknown) => Promise<unknown>) => {
            let release = () => {};
            const tx = {
                ...client,
                // The row lock: whoever asks second waits for the first
                // transaction to end.
                $queryRaw: async () => {
                    const before = lock;
                    lock = new Promise<void>((resolve) => {
                        release = resolve;
                    });
                    await before;
                    return [];
                }
            };
            try {
                return await run(tx);
            } finally {
                release();
            }
        }
    };
    return { prisma: client };
});

const service = await import("@/lib/chat/custom-emoji");
const { ChatAccessError } = await import("@/lib/chat/access");

const ada = { id: "ada" };
let still: Uint8Array;
let moving: Uint8Array;

beforeEach(async () => {
    role = "owner";
    rows = [];
    placed = [];
    removed = [];
    announced = 0;
    lock = Promise.resolve();
    const frame = (red: number) =>
        sharp({
            create: {
                width: 8,
                height: 8,
                channels: 4,
                background: { r: red, g: 0, b: 0, alpha: 1 }
            }
        })
            .png()
            .toBuffer();
    still ??= new Uint8Array(await frame(200));
    moving ??= new Uint8Array(
        await sharp([await frame(255), await frame(0)], { join: { animated: true } })
            .gif()
            .toBuffer()
    );
});

const upload = (name: string, bytes = still) =>
    service.uploadSpaceEmoji(ada, SPACE, { name, bytes });

describe("who may change a space's emoji", () => {
    it("is its owner and its administrators", async () => {
        await expect(upload("owner_one")).resolves.toMatchObject({
            name: "owner_one",
            uploaderId: "ada"
        });
        role = "admin";
        await expect(upload("admin_one")).resolves.toMatchObject({ name: "admin_one" });
        expect(announced).toBe(2);
    });

    it("is not a member, nor somebody outside the space", async () => {
        role = "member";
        await expect(upload("nope")).rejects.toBeInstanceOf(ChatAccessError);
        role = null;
        await expect(upload("nope")).rejects.toBeInstanceOf(ChatAccessError);
        expect(placed).toEqual([]);
    });

    it("lets a member read the list but says they cannot change it", async () => {
        seed(2, false);
        role = "member";
        const list = await service.listSpaceEmoji(ada, SPACE);
        expect(list.emoji).toHaveLength(2);
        expect(list.manages).toBe(false);
    });

    it("refuses a rename or delete from a member", async () => {
        seed(1, false);
        role = "member";
        await expect(
            service.renameSpaceEmoji(ada, { emojiId: rows[0]!.id, name: "renamed" })
        ).rejects.toBeInstanceOf(ChatAccessError);
        await expect(service.deleteSpaceEmoji(ada, rows[0]!.id)).rejects.toBeInstanceOf(
            ChatAccessError
        );
        expect(rows).toHaveLength(1);
    });
});

describe("a name", () => {
    it("is checked on the server whatever the screen let through", async () => {
        await expect(upload("x")).rejects.toThrow(/at least 2/);
        await expect(upload("has space")).rejects.toThrow(/letters, digits/);
        await expect(upload("a".repeat(33))).rejects.toThrow(/up to 32/);
        expect(placed).toEqual([]);
    });

    it("is unique in the space ignoring case, and the file is taken back", async () => {
        await upload("Parrot");
        await expect(upload("parrot")).rejects.toThrow(/already has an emoji with that name/);
        expect(rows).toHaveLength(1);
        expect(removed).toHaveLength(1);
        expect(removed[0]).toBe(placed[1]);
    });

    it("can be changed, and not to one already taken", async () => {
        const first = await upload("first");
        await upload("second");
        await expect(
            service.renameSpaceEmoji(ada, { emojiId: first.id, name: "Second" })
        ).rejects.toThrow(/already has an emoji with that name/);
        await expect(
            service.renameSpaceEmoji(ada, { emojiId: first.id, name: "renamed" })
        ).resolves.toMatchObject({ name: "renamed" });
    });
});

describe("the file", () => {
    it("is refused by its bytes before anything is stored", async () => {
        await expect(upload("fake", new Uint8Array(Buffer.from("<svg></svg>")))).rejects.toThrow(
            /PNG, JPG, GIF or WEBP/
        );
        expect(placed).toEqual([]);
    });

    it("goes under the space's own folder, apart from the attachments", async () => {
        await upload("placed");
        expect(placed[0]).toMatch(new RegExp(`^polaris/chat-emoji/${SPACE}/[0-9a-f-]+\\.png$`));
    });

    it("is removed with its row", async () => {
        const made = await upload("gone_soon");
        await service.deleteSpaceEmoji(ada, made.id);
        expect(rows).toEqual([]);
        expect(removed).toEqual([placed[0]]);
    });
});

describe("the fifty slots", () => {
    it("are counted apart for still and animated ones", async () => {
        seed(CUSTOM_EMOJI_SLOTS, false);
        await expect(upload("one_more")).rejects.toThrow(/all 50 emoji slots/);
        await expect(upload("moving_one", moving)).resolves.toMatchObject({ animated: true });
        seed(CUSTOM_EMOJI_SLOTS - 1, true);
        await expect(upload("moving_two", moving)).rejects.toThrow(/all 50 animated/);
    });

    it("hold when several uploads race for the last one", async () => {
        seed(CUSTOM_EMOJI_SLOTS - 1, false);
        const results = await Promise.allSettled([
            upload("race_a"),
            upload("race_b"),
            upload("race_c")
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(2);
        expect(rows.filter((row) => !row.animated)).toHaveLength(CUSTOM_EMOJI_SLOTS);
        // The two that lost leave no file behind.
        expect(removed).toHaveLength(2);
    });
});

describe("reading one's picture", () => {
    it("is for somebody in its space, and nobody else", async () => {
        const made = await upload("seen");
        role = "member";
        await expect(service.readSpaceEmoji(ada, made.id)).resolves.toMatchObject({
            mime: "image/png"
        });
        role = null;
        await expect(service.readSpaceEmoji(ada, made.id)).resolves.toBeNull();
    });

    it("is nothing for an emoji that is gone", async () => {
        await expect(service.readSpaceEmoji(ada, crypto.randomUUID())).resolves.toBeNull();
    });
});
