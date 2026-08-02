import { describe, expect, it } from "vitest";
import { groupVisitPath, parseVisitAgent, parseVisitSource } from "../src/analytics-visit.js";

const CHROME =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const SAFARI_IOS =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";
const EDGE =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";
const IPAD =
    "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/604.1";
const ANDROID_TABLET = "Mozilla/5.0 (Linux; Android 14; SM-X200) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36";

describe("parseVisitAgent", () => {
    it("reads the common desktop browsers", () => {
        expect(parseVisitAgent(CHROME)).toEqual({ browser: "Chrome", os: "Windows", device: "desktop" });
        expect(parseVisitAgent(FIREFOX_LINUX)).toEqual({ browser: "Firefox", os: "Linux", device: "desktop" });
    });

    it("does not let Edge be counted as Chrome", () => {
        expect(parseVisitAgent(EDGE).browser).toBe("Edge");
    });

    it("does not let Chrome be counted as Safari", () => {
        expect(parseVisitAgent(CHROME).browser).toBe("Chrome");
    });

    it("reads phones and tablets apart", () => {
        expect(parseVisitAgent(SAFARI_IOS)).toEqual({ browser: "Safari", os: "iOS", device: "mobile" });
        expect(parseVisitAgent(IPAD).device).toBe("tablet");
        expect(parseVisitAgent(ANDROID_TABLET).device).toBe("tablet");
    });

    it("keeps Android phones as mobile", () => {
        const phone = "Mozilla/5.0 (Linux; Android 14; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36";
        expect(parseVisitAgent(phone)).toMatchObject({ os: "Android", device: "mobile" });
    });

    it.each([
        ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "Googlebot"],
        ["curl/8.5.0", "curl"],
        ["python-requests/2.32", "python-requests"],
        ["Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", "bingbot"]
    ])("recognises %s as a bot", (agent, name) => {
        const parsed = parseVisitAgent(agent);
        expect(parsed.device).toBe("bot");
        expect(parsed.browser).toBe(name);
    });

    it("treats a headless browser as a bot however much it claims to be Chrome", () => {
        expect(parseVisitAgent(`${CHROME} HeadlessChrome/140.0`).device).toBe("bot");
    });

    it("says unknown rather than guessing when there is nothing to read", () => {
        for (const value of [null, undefined, "", "-"]) {
            expect(parseVisitAgent(value)).toEqual({ browser: "Unknown", os: "Unknown", device: "unknown" });
        }
    });
});

describe("parseVisitSource", () => {
    it("calls a missing referrer direct", () => {
        expect(parseVisitSource(null)).toMatchObject({ kind: "direct", source: null });
        expect(parseVisitSource("-")).toMatchObject({ kind: "direct" });
        expect(parseVisitSource("not a url")).toMatchObject({ kind: "direct" });
    });

    it("names the search engine", () => {
        expect(parseVisitSource("https://www.google.com/search?q=polaris")).toMatchObject({
            kind: "search",
            source: "Google"
        });
        expect(parseVisitSource("https://duckduckgo.com/")).toMatchObject({ kind: "search", source: "DuckDuckGo" });
    });

    it("counts an answer engine as search", () => {
        expect(parseVisitSource("https://chatgpt.com/")).toMatchObject({ kind: "search", source: "ChatGPT" });
    });

    it("names the social network, including its link shortener", () => {
        expect(parseVisitSource("https://t.co/abc")).toMatchObject({ kind: "social", source: "X" });
        expect(parseVisitSource("https://news.ycombinator.com/item?id=1")).toMatchObject({
            kind: "social",
            source: "Hacker News"
        });
    });

    it("falls back to the bare hostname for anything else", () => {
        expect(parseVisitSource("https://www.example.com/blog/post")).toMatchObject({
            kind: "referral",
            source: "example.com"
        });
    });

    it("does not count a site's own links as referrals from itself", () => {
        expect(parseVisitSource("https://shop.example.com/a", null, "shop.example.com")).toMatchObject({
            kind: "direct"
        });
    });

    it("lets a campaign win over the referrer, which is the point of tagging one", () => {
        const source = parseVisitSource("https://mail.google.com/", "utm_source=newsletter&utm_medium=email&utm_campaign=launch");
        expect(source).toEqual({ kind: "campaign", source: "newsletter", medium: "email", campaign: "launch" });
    });

    it("accepts a bare ref parameter", () => {
        expect(parseVisitSource(null, "?ref=producthunt")).toMatchObject({ kind: "campaign", source: "producthunt" });
    });

    it("ignores a query with no campaign in it", () => {
        expect(parseVisitSource("https://example.com/", "?page=2")).toMatchObject({ kind: "referral" });
    });
});

describe("groupVisitPath", () => {
    it("groups numeric and uuid segments", () => {
        expect(groupVisitPath("/post/1")).toBe("/post/:id");
        expect(groupVisitPath("/users/019fc074-a89b-7321-b493-58f5a762c2b6/edit")).toBe("/users/:id/edit");
    });

    it("groups a long hex id", () => {
        expect(groupVisitPath("/o/3f9a2b1c8e7d6540")).toBe("/o/:id");
    });

    it("leaves real page names alone, which is the whole point", () => {
        expect(groupVisitPath("/about")).toBe("/about");
        expect(groupVisitPath("/blog/how-we-ship")).toBe("/blog/how-we-ship");
        expect(groupVisitPath("/pricing/?ref=x")).toBe("/pricing");
    });

    it("normalises the root", () => {
        expect(groupVisitPath("/")).toBe("/");
        expect(groupVisitPath("")).toBe("/");
    });
});
