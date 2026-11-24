/**
 * mDNS responses shaped like the ones the TVs send, built to RFC 1035 / 6762 with
 * name compression (as real responders use it), so the reader is tested on the
 * same byte layout without a network. Instance and host names follow what adbd
 * (`adb-<serial>-<suffix>`) and a Cast device (`<Model>-<uuid>`) announce; every
 * serial, uuid and address here is made up.
 */

type Rr =
    | { name: string; type: "PTR"; target: string; }
    | { name: string; type: "SRV"; port: number; target: string; }
    | { name: string; type: "A"; address: string; }
    | { name: string; type: "TXT"; entries: string[]; };

const TYPES = { A: 1, PTR: 12, TXT: 16, SRV: 33 } as const;

/** Writes names with compression: a suffix written before is pointed at, not repeated. */
class Writer {
    private readonly parts: Buffer[] = [];
    private length = 0;
    private readonly seen = new Map<string, number>();

    push(bytes: Buffer): void {
        this.parts.push(bytes);
        this.length += bytes.length;
    }

    get offset(): number {
        return this.length;
    }

    name(name: string, into: Buffer[] = []): Buffer {
        const labels = name.split(".");
        const out: Buffer[] = [];
        let at = this.offset + into.reduce((sum, part) => sum + part.length, 0);
        for (let index = 0; index < labels.length; index += 1) {
            const suffix = labels.slice(index).join(".").toLowerCase();
            const pointer = this.seen.get(suffix);
            if (pointer !== undefined) {
                out.push(Buffer.from([0xc0 | (pointer >> 8), pointer & 0xff]));
                return Buffer.concat(out);
            }
            this.seen.set(suffix, at);
            const label = Buffer.from(labels[index]!, "utf8");
            const chunk = Buffer.concat([Buffer.from([label.length]), label]);
            out.push(chunk);
            at += chunk.length;
        }
        out.push(Buffer.from([0]));
        return Buffer.concat(out);
    }

    done(): Buffer {
        return Buffer.concat(this.parts);
    }
}

function u16(value: number): Buffer {
    const bytes = Buffer.alloc(2);
    bytes.writeUInt16BE(value);
    return bytes;
}

/** A response (QR bit set) carrying `answers` then `additional`, each record class IN with cache-flush. */
export function response(answers: Rr[], additional: Rr[] = []): Buffer {
    const writer = new Writer();
    writer.push(Buffer.concat([u16(0), u16(0x8400), u16(0), u16(answers.length), u16(0), u16(additional.length)]));
    for (const record of [...answers, ...additional]) {
        writer.push(writer.name(record.name));
        const head = Buffer.concat([u16(TYPES[record.type]), u16(0x8001), Buffer.from([0, 0, 0x11, 0x94])]);
        writer.push(head);
        // The rdata's names are compressed against what was written, starting after the length field.
        let rdata: Buffer;
        if (record.type === "PTR") rdata = writer.name(record.target, [Buffer.alloc(2)]);
        else if (record.type === "SRV")
            rdata = Buffer.concat([u16(0), u16(0), u16(record.port), writer.name(record.target, [Buffer.alloc(8)])]);
        else if (record.type === "A") rdata = Buffer.from(record.address.split(".").map(Number));
        else
            rdata = Buffer.concat(
                record.entries.map((entry) => {
                    const bytes = Buffer.from(entry, "utf8");
                    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
                })
            );
        writer.push(Buffer.concat([u16(rdata.length), rdata]));
    }
    return writer.done();
}

/** A Chromecast with Google TV: Cast record, and Wireless debugging's pairing service only. */
export const CHROMECAST_GOOGLE_TV = response(
    [
        { name: "_googlecast._tcp.local", type: "PTR", target: "Chromecast-HD-0a1b2c3d4e5f._googlecast._tcp.local" },
        { name: "_adb-tls-pairing._tcp.local", type: "PTR", target: "adb-FIXTURE0001-AbCdEf._adb-tls-pairing._tcp.local" }
    ],
    [
        {
            name: "Chromecast-HD-0a1b2c3d4e5f._googlecast._tcp.local",
            type: "TXT",
            entries: ["id=0a1b2c3d4e5f", "md=Chromecast HD", "fn=Living Room TV", "ve=05"]
        },
        { name: "Chromecast-HD-0a1b2c3d4e5f._googlecast._tcp.local", type: "SRV", port: 8009, target: "0a1b2c3d-fixture.local" },
        { name: "adb-FIXTURE0001-AbCdEf._adb-tls-pairing._tcp.local", type: "SRV", port: 37215, target: "Android.local" },
        { name: "0a1b2c3d-fixture.local", type: "A", address: "192.168.1.40" },
        { name: "Android.local", type: "A", address: "192.168.1.40" }
    ]
);

/** An Android TV with network debugging on: the classic `_adb._tcp` service, no address record. */
export const ANDROID_TV_ADB = response([
    { name: "_adb._tcp.local", type: "PTR", target: "adb-FIXTURE0002._adb._tcp.local" }
]);

/** A printer on the same network: not a TV service, so nothing is taken from it. */
export const PRINTER = response(
    [{ name: "_ipp._tcp.local", type: "PTR", target: "Office Printer._ipp._tcp.local" }],
    [{ name: "printer.local", type: "A", address: "192.168.1.9" }]
);
