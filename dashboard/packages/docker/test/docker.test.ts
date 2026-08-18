import { Duplex } from "node:stream";
import { streamRpc } from "../src/rpc.js";
import { describe, expect, it } from "vitest";
import { DockerDriver } from "../src/driver.js";
import type { DockerTransportConn } from "../src/transports.js";

/** A stream that answers each written request with a canned HTTP response. */
class CannedStream extends Duplex {
    public constructor(private readonly response: Buffer) {
        super();
    }
    public override _read(): void {}
    public override _write(_chunk: Buffer, _enc: string, cb: () => void): void {
        this.push(this.response);
        this.push(null);
        cb();
    }
}

function httpResponse(status: string, json: unknown): Buffer {
    const body = JSON.stringify(json);
    return Buffer.from(
        `HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
    );
}

function driverReturning(response: Buffer): DockerDriver {
    const conn: DockerTransportConn = {
        stream: async () => new CannedStream(response),
        close: async () => undefined
    };
    return new DockerDriver(streamRpc(conn));
}

/** A driver answering a scripted sequence, one canned reply per request. Exec
 *  takes three round trips (create, start, inspect), so it needs this. */
function driverReturningEach(responses: Buffer[]): DockerDriver {
    let index = 0;
    const conn: DockerTransportConn = {
        stream: async () => new CannedStream(responses[index++] ?? Buffer.alloc(0)),
        close: async () => undefined
    };
    return new DockerDriver(streamRpc(conn));
}

/** One frame of Docker's multiplexed stream format: an 8-byte header carrying
 *  the stream id and a big-endian payload length, then the payload. */
function frame(stream: 1 | 2, payload: string): Buffer {
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(Buffer.byteLength(payload), 4);
    return Buffer.concat([header, Buffer.from(payload)]);
}

function rawResponse(status: string, body: Buffer): Buffer {
    return Buffer.concat([
        Buffer.from(`HTTP/1.1 ${status}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`),
        body
    ]);
}

describe("docker driver", () => {
    it("parses /info into a typed overview", async () => {
        const driver = driverReturning(
            httpResponse("200 OK", {
                Name: "host1",
                ServerVersion: "27.0.0",
                Containers: 5,
                ContainersRunning: 3,
                ContainersStopped: 2,
                Images: 10,
                NCPU: 8,
                MemTotal: 16_000_000_000
            })
        );
        const info = await driver.info();
        expect(info.containersRunning).toBe(3);
        expect(info.ncpu).toBe(8);
        expect(info.serverVersion).toBe("27.0.0");
    });

    it("maps container listings and strips the leading slash from names", async () => {
        const driver = driverReturning(
            httpResponse("200 OK", [
                { Id: "abc123", Names: ["/web"], Image: "nginx", State: "running", Status: "Up 2 hours" }
            ])
        );
        const [container] = await driver.listContainers();
        expect(container?.name).toBe("web");
        expect(container?.state).toBe("running");
    });

    it("computes CPU percent and memory from a stats sample", async () => {
        const driver = driverReturning(
            httpResponse("200 OK", {
                cpu_stats: {
                    cpu_usage: { total_usage: 200 },
                    system_cpu_usage: 2000,
                    online_cpus: 2
                },
                precpu_stats: {
                    cpu_usage: { total_usage: 100 },
                    system_cpu_usage: 1000
                },
                memory_stats: { usage: 150, limit: 1000, stats: { cache: 50 } }
            })
        );
        const stats = await driver.stats("abc");
        // cpuDelta=100, sysDelta=1000 -> a tenth of the machine. The core count does
        // not enter into it: sysDelta already counts every core.
        expect(stats.cpuPercent).toBe(10);
        // memUsage = 150 - 50 = 100; limit 1000 -> 10%
        expect(stats.memUsage).toBe(100);
        expect(stats.memPercent).toBe(10);
    });

    it("treats 304 on lifecycle actions as success", async () => {
        const driver = driverReturning(Buffer.from("HTTP/1.1 304 Not Modified\r\nConnection: close\r\n\r\n"));
        await expect(driver.start("abc")).resolves.toBeUndefined();
    });

    it("de-multiplexes framed logs into what the container printed", async () => {
        const driver = driverReturning(
            rawResponse("200 OK", Buffer.concat([frame(1, "first\n"), frame(2, "warning\n"), frame(1, "second\n")]))
        );
        expect(await driver.logs("abc")).toBe("first\nwarning\nsecond\n");
    });

    it("passes an unframed (TTY) log through untouched", async () => {
        const driver = driverReturning(rawResponse("200 OK", Buffer.from("plain tty output\n")));
        expect(await driver.logs("abc")).toBe("plain tty output\n");
    });

    it("bounds the requested tail rather than trusting the caller", async () => {
        let requested = "";
        const conn: DockerTransportConn = {
            stream: async () => {
                const stream = new CannedStream(rawResponse("200 OK", frame(1, "x")));
                stream.on("finish", () => undefined);
                const original = stream._write.bind(stream);
                stream._write = (chunk: Buffer, enc: string, cb: () => void) => {
                    requested += chunk.toString();
                    original(chunk, enc, cb);
                };
                return stream;
            },
            close: async () => undefined
        };
        await new DockerDriver(streamRpc(conn)).logs("abc", 10_000_000);
        expect(requested).toContain("tail=5000");
    });

    it("keeps an exec's stdout and stderr apart and reports its exit code", async () => {
        const driver = driverReturningEach([
            httpResponse("201 Created", { Id: "exec1" }),
            rawResponse("200 OK", Buffer.concat([frame(1, "bin/\netc/\n"), frame(2, "ignored\n")])),
            httpResponse("200 OK", { ExitCode: 0 })
        ]);
        const result = await driver.exec("abc", ["ls"]);
        expect(result.stdout).toBe("bin/\netc/\n");
        expect(result.stderr).toBe("ignored\n");
        expect(result.code).toBe(0);
    });

    it("refuses a removal the engine did not confirm", async () => {
        const driver = driverReturning(httpResponse("409 Conflict", { message: "container is running" }));
        await expect(driver.remove("abc")).rejects.toThrow(/409/);
    });

    it("accepts a 204 removal", async () => {
        const driver = driverReturning(Buffer.from("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n"));
        await expect(driver.remove("abc", { force: true })).resolves.toBeUndefined();
    });

    it("reports that a proxied connection cannot attach a console", () => {
        const driver = new DockerDriver({
            request: async () => ({ status: 200, body: "{}", bytes: Buffer.from("{}") }),
            dispose: async () => undefined
        });
        expect(driver.canAttach).toBe(false);
    });
});

/**
 * Over SSH each of these streams is an exec channel, and a server allows a
 * bounded number of them at once. Reading the reply and walking away left the
 * far side waiting on an EOF that never came, so the channels accumulated until
 * the host started refusing new ones - on a host with nothing wrong with it.
 */
describe("the stream a request was made on", () => {
    function recordingDriver(response: Buffer): { driver: DockerDriver; streams: CannedStream[] } {
        const streams: CannedStream[] = [];
        const conn: DockerTransportConn = {
            stream: async () => {
                const stream = new CannedStream(response);
                streams.push(stream);
                return stream;
            },
            close: async () => undefined
        };
        return { driver: new DockerDriver(streamRpc(conn)), streams };
    }

    it("is closed once the reply has been read", async () => {
        const { driver, streams } = recordingDriver(httpResponse("200 OK", []));
        await driver.listContainers();
        expect(streams).toHaveLength(1);
        expect(streams[0]?.destroyed).toBe(true);
    });

    it("is closed for every call, so repeated reads do not accumulate", async () => {
        const { driver, streams } = recordingDriver(httpResponse("200 OK", []));
        for (let call = 0; call < 12; call += 1) await driver.listContainers();
        expect(streams).toHaveLength(12);
        expect(streams.every((stream) => stream.destroyed)).toBe(true);
    });

    it("is closed when the engine answers with an error", async () => {
        const { driver, streams } = recordingDriver(httpResponse("500 Server Error", { message: "boom" }));
        await expect(driver.listContainers()).rejects.toThrow(/500/);
        expect(streams[0]?.destroyed).toBe(true);
    });
});
