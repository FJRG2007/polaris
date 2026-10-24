import { join } from "node:path";
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    arrangeSections,
    docNeighbors,
    docSlug,
    integrationsGuide,
    readmeSections,
    rewriteDocLinks
} from "../../src/data/docs";

const README = `# Polaris

## A look inside

### Talk

- [Chat](docs/features/chat.md) and [calls](docs/features/calls.md)

### Work

See [Tasks](docs/features/tasks.es.md) and [Chat again](docs/features/chat.md).

## How it works

### Updating

Nothing linked here.

## Everything connects

The services Polaris already talks to.

| | |
| --- | --- |
| <img src="docs/assets/logos/google.svg" alt="Google"> | Mail and calendar |
| <img src="docs/assets/logos/telegram.svg" alt="Telegram"> <img src="docs/assets/logos/whatsapp.svg" alt="WhatsApp"> | Chat bridges |

Mail also takes any IMAP account.

## License
`;

describe("the docs sections", () => {
    it("follows the README's own groups, in its order, a guide in its first group only", () => {
        expect(readmeSections(README)).toEqual([
            { label: "Talk", slugs: ["chat", "calls"] },
            { label: "Work", slugs: ["tasks"] }
        ]);
    });

    it("puts a guide no group names in a last group, and drops slugs with no page", () => {
        const sections = arrangeSections(
            [...readmeSections(README), { label: "Integrations", slugs: ["integrations", "gone"] }],
            ["calls", "chat", "tasks", "integrations", "new-guide"],
            "More"
        );
        expect(sections.map((section) => section.label)).toEqual([
            "Talk",
            "Work",
            "Integrations",
            "More"
        ]);
        expect(sections.at(-1)!.slugs).toEqual(["new-guide"]);
    });

    it("links each page to the ones before and after it across groups", () => {
        const sections = readmeSections(README);
        expect(docNeighbors(sections, "calls")).toEqual({
            previous: "chat",
            next: "tasks",
            section: "Talk"
        });
        expect(docNeighbors(sections, "chat").previous).toBeNull();
        expect(docNeighbors(sections, "tasks").next).toBeNull();
    });
});

describe("the integrations guide", () => {
    it("turns each row of the logo table into a section named after its services", () => {
        const guide = integrationsGuide(README)!;
        expect(guide.title).toBe("Everything connects");
        expect(guide.markdown).toContain("## Google");
        expect(guide.markdown).toContain("## Telegram, WhatsApp");
        expect(guide.markdown).toContain("Chat bridges");
        expect(guide.markdown).toContain("Mail also takes any IMAP account.");
        expect(guide.markdown).not.toContain("| --- |");
    });

    it("is absent when the README has no logo table", () => {
        expect(integrationsGuide("# Polaris\n\n## Install\n\nText.\n")).toBeNull();
    });
});

describe("slugs and links", () => {
    it("keeps every existing guide at the address it already had", () => {
        const dir = join(__dirname, "..", "..", "..", "..", "..", "docs", "features");
        for (const file of readdirSync(dir).filter((name) => name.endsWith(".md")))
            expect(docSlug(file)).toBe(file.replace(/(\.es)?\.md$/, ""));
        expect(docSlug("connecting-ai-assistants.md")).toBe("connecting-ai-assistants");
    });

    it("points a guide outside docs/features at its page, and a logo at the site's copy", () => {
        const { html } = rewriteDocLinks(
            '<a href="../connecting-ai-assistants.md#clients">x</a><img src="docs/assets/logos/google.svg">',
            {
                slugs: new Set(),
                repo: "owner/polaris",
                dir: "docs/developers",
                paths: new Map([["docs/connecting-ai-assistants.md", "connecting-ai-assistants"]])
            }
        );
        expect(html).toContain('href="../connecting-ai-assistants/#clients"');
        expect(html).toContain('src="../../../logos/google.svg"');
    });
});
