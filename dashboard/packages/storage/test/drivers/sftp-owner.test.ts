import { describe, expect, it } from "vitest";
import { Readable, Writable } from "node:stream";
import { SftpDriver } from "../../src/drivers/sftp.js";

type Callback = (error: (Error & { code?: number }) | null, value?: unknown) => void;

interface Node {
    kind: "dir" | "file";
    uid: number;
    gid: number;
}

/** An in-memory SFTP channel where everything is written as root (uid 0). */
function rootChannel(tree: Map<string, Node>, chowned: string[]) {
    const stats = (node: Node) => ({
        size: 0,
        mtime: 0,
        uid: node.uid,
        gid: node.gid,
        isDirectory: () => node.kind === "dir",
        isSymbolicLink: () => false
    });
    const missing = () => Object.assign(new Error("No such file"), { code: 2 });
    return {
        stat(path: string, callback: Callback) {
            const node = tree.get(path);
            if (node) callback(null, stats(node));
            else callback(missing());
        },
        mkdir(path: string, callback: Callback) {
            if (tree.has(path)) return callback(Object.assign(new Error("Failure"), { code: 4 }));
            tree.set(path, { kind: "dir", uid: 0, gid: 0 });
            callback(null);
        },
        chown(path: string, uid: number, gid: number, callback: Callback) {
            const node = tree.get(path);
            if (!node) return callback(missing());
            node.uid = uid;
            node.gid = gid;
            chowned.push(path);
            callback(null);
        },
        createWriteStream(path: string) {
            if (!tree.has(path)) tree.set(path, { kind: "file", uid: 0, gid: 0 });
            return new Writable({ write: (_chunk, _encoding, next) => next() });
        }
    };
}

function driverOn(tree: Map<string, Node>, chowned: string[], inheritOwner: boolean): SftpDriver {
    const driver = new SftpDriver({
        id: "test",
        root: "/",
        inheritOwner,
        session: async () => ({}) as never
    });
    (driver as unknown as { sftp: unknown }).sftp = rootChannel(tree, chowned);
    return driver;
}

const body = () => Readable.toWeb(Readable.from(Buffer.from("data"))) as ReadableStream<Uint8Array>;

describe("sftp driver writing as root", () => {
    it("hands what it creates to the owner of the folder it lands in", async () => {
        const tree = new Map<string, Node>([
            ["/home/deploy/app", { kind: "dir", uid: 1000, gid: 1000 }]
        ]);
        const chowned: string[] = [];
        const driver = driverOn(tree, chowned, true);
        await driver.writeStream("home/deploy/app/build/out.txt", body());
        expect(tree.get("/home/deploy/app/build")).toMatchObject({ uid: 1000, gid: 1000 });
        expect(tree.get("/home/deploy/app/build/out.txt")).toMatchObject({ uid: 1000, gid: 1000 });
    });

    it("leaves a file that was already there with its own owner", async () => {
        const tree = new Map<string, Node>([
            ["/srv", { kind: "dir", uid: 1000, gid: 1000 }],
            ["/srv/config.yml", { kind: "file", uid: 33, gid: 33 }]
        ]);
        const chowned: string[] = [];
        await driverOn(tree, chowned, true).writeStream("srv/config.yml", body());
        expect(chowned).toEqual([]);
        expect(tree.get("/srv/config.yml")).toMatchObject({ uid: 33, gid: 33 });
    });

    it("changes no owner unless asked to", async () => {
        const tree = new Map<string, Node>([["/srv", { kind: "dir", uid: 1000, gid: 1000 }]]);
        const chowned: string[] = [];
        const driver = driverOn(tree, chowned, false);
        await driver.mkdir("srv/new");
        await driver.writeStream("srv/new/file.txt", body());
        expect(chowned).toEqual([]);
    });
});
