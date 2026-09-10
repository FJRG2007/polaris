import { it } from "vitest";
import { marked } from "marked";
import * as md from "@/components/rich-text/markdown";

it("scratch", () => {
    const out: string[] = [];
    for (const body of ["\n\n-- \nMe, Example Ltd", "Hi there\n\n-- \nMe\nLine two", "Hi\n\n-- \nMe\n\nOn Monday, x wrote:\n> Hello"]) {
        const doc = md.markdownToDoc(body);
        out.push(JSON.stringify(body), JSON.stringify(doc), JSON.stringify(md.docToMarkdown(doc)));
        out.push(JSON.stringify(marked.parse(body, { async: false, gfm: true, breaks: true })));
    }
    throw new Error(out.join("\n"));
});
