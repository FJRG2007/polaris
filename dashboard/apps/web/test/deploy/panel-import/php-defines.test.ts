/**
 * Changing a PHP file's `define` calls: only real calls, only their value, and
 * every other byte of the file kept.
 */

import { describe, expect, it } from "vitest";
import { findDefines, phpLiteral, rewriteDefines } from "@/lib/deploy/panel-import/php-defines";

const WP_CONFIG = `<?php
/**
 * The base configuration for WordPress
 * define( 'DB_NAME', 'in_a_doc_comment' );
 */

// ** Database settings ** //
define( 'DB_NAME', 'acct_wp' );
define( "DB_USER", "acct_user" );
define('DB_PASSWORD', 'it\\'s \\\\ secret');
define( 'DB_HOST', getenv( 'DB_HOST' ) ?: 'localhost' );
define( 'DB_CHARSET', 'utf8mb4' );
# define( 'DB_HOST', 'hash_comment' );
$table_prefix = 'wp_';
$note = "define('DB_NAME', 'in_a_string')";
$doc = <<<EOT
define('DB_NAME', 'in_a_heredoc');
EOT;
$wpdb->define( 'DB_NAME', 'a_method' );
require_once ABSPATH . 'wp-settings.php';
`;

describe("findDefines", () => {
    it("finds only the real calls, with their plain values", () => {
        const calls = findDefines(WP_CONFIG);
        expect(calls.map((call) => [call.name, call.value])).toEqual([
            ["DB_NAME", "acct_wp"],
            ["DB_USER", "acct_user"],
            ["DB_PASSWORD", "it's \\ secret"],
            ["DB_HOST", null],
            ["DB_CHARSET", "utf8mb4"]
        ]);
    });

    it("skips inline text outside the PHP tags", () => {
        const source = `define('DB_NAME', 'html');\n<?php define('DB_NAME', 'php'); ?>\ndefine('DB_NAME', 'html again');`;
        expect(findDefines(source).map((call) => call.value)).toEqual(["php"]);
    });

    it("keeps a double-quoted value with something interpolated as unknown", () => {
        expect(findDefines(`<?php define("DB_NAME", "site_$env");`)[0]?.value).toBeNull();
    });
});

describe("rewriteDefines", () => {
    const values = { DB_NAME: "imported", DB_USER: "polaris", DB_PASSWORD: "p'a\\ss", DB_HOST: "mysql-1:3306" };

    it("replaces each value and leaves the rest of the file as it was", () => {
        const { text, changed } = rewriteDefines(WP_CONFIG, values);
        expect(changed).toEqual(["DB_NAME", "DB_USER", "DB_PASSWORD", "DB_HOST"]);
        expect(text).toContain("define( 'DB_NAME', 'imported' );");
        expect(text).toContain(`define( "DB_USER", 'polaris' );`);
        expect(text).toContain("define('DB_PASSWORD', 'p\\'a\\\\ss');");
        expect(text).toContain("define( 'DB_HOST', 'mysql-1:3306' );");
        // Untouched: comments, strings, the heredoc, the method and the charset.
        for (const kept of ["in_a_doc_comment", "hash_comment", "in_a_string", "in_a_heredoc", "a_method", "utf8mb4"]) {
            expect(text).toContain(kept);
        }
        // Reading it back gives the new values.
        const read = Object.fromEntries(findDefines(text).map((call) => [call.name, call.value]));
        expect(read).toMatchObject(values);
    });

    it("changes nothing in a file without those defines", () => {
        const source = "<?php\necho 'hello';\n";
        expect(rewriteDefines(source, values)).toEqual({ text: source, changed: [] });
    });

    it("keeps a third argument", () => {
        expect(rewriteDefines("<?php define('DB_NAME', 'old', true);", { DB_NAME: "new" }).text).toBe(
            "<?php define('DB_NAME', 'new', true);"
        );
    });
});

describe("phpLiteral", () => {
    it("escapes quotes and backslashes", () => {
        expect(phpLiteral("a'b\\c")).toBe("'a\\'b\\\\c'");
    });
});
