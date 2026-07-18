import { Duplex } from "node:stream";
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
    return new DockerDriver(conn);
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
        // cpuDelta=100, sysDelta=1000, online=2 -> (100/1000)*2*100 = 20
        expect(stats.cpuPercent).toBe(20);
        // memUsage = 150 - 50 = 100; limit 1000 -> 10%
        expect(stats.memUsage).toBe(100);
        expect(stats.memPercent).toBe(10);
    });

    it("treats 304 on lifecycle actions as success", async () => {
        const driver = driverReturning(Buffer.from("HTTP/1.1 304 Not Modified\r\nConnection: close\r\n\r\n"));
        await expect(driver.start("abc")).resolves.toBeUndefined();
    });
});
