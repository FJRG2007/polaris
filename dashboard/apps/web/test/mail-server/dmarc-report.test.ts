/**
 * Getting a DMARC report out of whatever it arrived as: bare XML, gzip, zip, or
 * the whole message with one of those attached - and refusing what is not one.
 */

import JSZip from "jszip";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

const dmarc = await import("@/lib/mail-server/dmarc-report");

const REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<feedback>
  <report_metadata>
    <org_name>google.com</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <report_id>12345678901234567890</report_id>
    <date_range><begin>1756598400</begin><end>1756684799</end></date_range>
  </report_metadata>
  <policy_published><domain>example.com</domain><p>quarantine</p><pct>100</pct></policy_published>
  <record>
    <row>
      <source_ip>203.0.113.7</source_ip>
      <count>4</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>fail</spf></policy_evaluated>
    </row>
    <identifiers><header_from>example.com</header_from></identifiers>
    <auth_results><dkim><domain>example.com</domain><result>pass</result><selector>s1</selector></dkim><spf><domain>example.com</domain><result>fail</result></spf></auth_results>
  </record>
  <record>
    <row>
      <source_ip>198.51.100.9</source_ip>
      <count>2</count>
      <policy_evaluated><disposition>quarantine</disposition><dkim>fail</dkim><spf>fail</spf></policy_evaluated>
    </row>
    <identifiers><header_from>example.com</header_from></identifiers>
    <auth_results><spf><domain>spoof.test</domain><result>pass</result></spf></auth_results>
  </record>
</feedback>`;

describe("unpacking", () => {
    it("reads bare XML, gzip and zip alike", async () => {
        const bare = await dmarc.unpackAttachment(Buffer.from(REPORT));
        const gz = await dmarc.unpackAttachment(gzipSync(Buffer.from(REPORT)));
        const zip = new JSZip();
        zip.file("google.com!example.com!1756598400!1756684799.xml", REPORT);
        const zipped = await dmarc.unpackAttachment(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
        expect(bare).toEqual([REPORT]);
        expect(gz).toEqual([REPORT]);
        expect(zipped).toEqual([REPORT]);
    });

    it("passes over a part that is not a report", async () => {
        expect(await dmarc.unpackAttachment(Buffer.from("Hello, this is a signature image."))).toEqual([]);
    });

    it("refuses a gzip that unpacks past any real report", async () => {
        const bomb = gzipSync(Buffer.alloc(25 * 1024 * 1024, 0x3c));
        await expect(dmarc.unpackAttachment(bomb)).rejects.toThrow(dmarc.DmarcUploadError);
    });
});

describe("reading", () => {
    it("keeps a twenty-digit report id as text and reads every row", () => {
        const report = dmarc.parseReportXml(REPORT);
        expect(report.reportId).toBe("12345678901234567890");
        expect(report.domain).toBe("example.com");
        expect(report.rows).toHaveLength(2);
        expect(report.rows[0]).toMatchObject({ sourceIp: "203.0.113.7", count: 4, dkim: "pass", spf: "fail" });
        expect(report.rows[1]?.authSpf[0]).toEqual({ domain: "spoof.test", result: "pass" });
    });

    it("refuses a document that declares entities", () => {
        const hostile = '<?xml version="1.0"?><!DOCTYPE feedback [<!ENTITY a "aaaa">]><feedback>&a;</feedback>';
        expect(() => dmarc.parseReportXml(hostile)).toThrow();
    });

    it("finds the report attached to a forwarded message", async () => {
        const attachment = gzipSync(Buffer.from(REPORT)).toString("base64");
        const message = [
            "From: noreply-dmarc-support@google.com",
            "To: dmarc-reports@example.com",
            "Subject: Report domain: example.com",
            "MIME-Version: 1.0",
            'Content-Type: multipart/mixed; boundary="b1"',
            "",
            "--b1",
            "Content-Type: text/plain",
            "",
            "Here is the report.",
            "--b1",
            'Content-Type: application/gzip; name="report.xml.gz"',
            'Content-Disposition: attachment; filename="report.xml.gz"',
            "Content-Transfer-Encoding: base64",
            "",
            attachment,
            "--b1--",
            ""
        ].join("\r\n");
        const reports = await dmarc.reportsInUpload(Buffer.from(message));
        expect(reports).toHaveLength(1);
        expect(reports[0]?.orgName).toBe("google.com");
    });

    it("says so when a file holds no report", async () => {
        await expect(dmarc.reportsInUpload(Buffer.from("plain text"))).rejects.toThrow(dmarc.DmarcUploadError);
    });
});
