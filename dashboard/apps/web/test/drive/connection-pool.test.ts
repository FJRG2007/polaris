import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

// The pool itself is tested in @polaris/ssh. What belongs here is the app's reuse on
// top of it: a channel or a session handed out after its connection died would fail
// every operation that borrowed it, which is the failure reuse can introduce and a
// connection per request never could.
describe("borrowed SFTP channels", () => {
    afterEach(() => {
        vi.doUnmock("@polaris/ssh");
        vi.resetModules();
    });

    it("opens one channel per connection and reopens after it ends", async () => {
        const sftp = new EventEmitter();
        const client = Object.assign(new EventEmitter(), {
            sftp: vi.fn((callback: (error: Error | undefined, channel: unknown) => void) => callback(undefined, sftp)),
            end: vi.fn()
        });
        vi.doMock("@polaris/ssh", async (importOriginal) => {
            const actual = await importOriginal<typeof import("@polaris/ssh")>();
            return { ...actual, openSshClient: vi.fn(async () => client) };
        });
        const { borrowSftp } = await import("@/lib/connection-pool");
        const options = { host: "h", port: 22, username: "u", auth: { method: "password" as const, password: "p" } };

        const first = await borrowSftp("drive", "host-a", options);
        first.release();
        const second = await borrowSftp("drive", "host-a", options);
        second.release();
        expect(first.sftp).toBe(second.sftp);
        expect(client.sftp).toHaveBeenCalledTimes(1);

        // The far end closed the channel: the next borrower gets a new one.
        sftp.emit("end");
        const third = await borrowSftp("drive", "host-a", options);
        third.release();
        expect(client.sftp).toHaveBeenCalledTimes(2);
    });
});

describe("borrowed SMB sessions", () => {
    /** A session that answers `stat` until it is told to start failing. */
    function fakeSession() {
        const session = {
            dead: false,
            stat: vi.fn(async () => {
                if (session.dead) throw new Error("STATUS_USER_SESSION_DELETED");
                return { size: 0, mtime: new Date(0), isDirectory: () => true };
            }),
            disconnect: vi.fn()
        };
        return session;
    }

    async function poolWith(sessions: ReturnType<typeof fakeSession>[]) {
        const openSmbSession = vi.fn(async () => {
            const next = sessions.shift();
            if (!next) throw new Error("no more sessions");
            return next as never;
        });
        vi.doMock("@polaris/storage", async (importOriginal) => {
            const actual = await importOriginal<typeof import("@polaris/storage")>();
            return { ...actual, openSmbSession };
        });
        return { openSmbSession, pool: await import("@/lib/connection-pool") };
    }

    const options = { host: "nas", port: 445, share: "files", username: "u", password: "p" };

    afterEach(() => {
        vi.doUnmock("@polaris/storage");
        vi.resetModules();
    });

    it("negotiates once and lends the same session after that", async () => {
        const first = fakeSession();
        const { openSmbSession, pool } = await poolWith([first, fakeSession()]);

        const one = await pool.borrowSmb("conn-a", options);
        one.release();
        const two = await pool.borrowSmb("conn-a", options);
        two.release();

        expect(one.session).toBe(two.session);
        expect(openSmbSession).toHaveBeenCalledTimes(1);
        // The session it just opened was already proved by `openSmbSession`; only the
        // one it found lying around is asked again.
        expect(first.stat).toHaveBeenCalledTimes(1);
    });

    it("replaces a pooled session that has died", async () => {
        const dead = fakeSession();
        const fresh = fakeSession();
        const { openSmbSession, pool } = await poolWith([dead, fresh]);

        (await pool.borrowSmb("conn-a", options)).release();
        dead.dead = true;

        const next = await pool.borrowSmb("conn-a", options);
        expect(next.session).toBe(fresh);
        expect(openSmbSession).toHaveBeenCalledTimes(2);
        // The dead one is hung up on rather than left in the pool.
        expect(dead.disconnect).toHaveBeenCalled();
        next.release();
    });

    it("keeps a session per connection and drops one on demand", async () => {
        const a = fakeSession();
        const b = fakeSession();
        const { openSmbSession, pool } = await poolWith([a, b, fakeSession()]);

        (await pool.borrowSmb("conn-a", options)).release();
        (await pool.borrowSmb("conn-b", options)).release();
        expect(openSmbSession).toHaveBeenCalledTimes(2);

        // An edited or deleted connection must not keep being browsed through the
        // session opened with what it used to say.
        pool.dropStorageConnection("conn-a");
        expect(a.disconnect).toHaveBeenCalled();
        expect(b.disconnect).not.toHaveBeenCalled();
        (await pool.borrowSmb("conn-a", options)).release();
        expect(openSmbSession).toHaveBeenCalledTimes(3);
    });
});
