/**
 * Lint, for the one class of mistake a typecheck cannot see and a test only finds
 * by luck: a hook called conditionally.
 *
 * A component that returns early before one of its hooks renders fine until the
 * render that takes the other branch, and then the tab dies with "Rendered more
 * hooks" or "Rendered fewer hooks" (React #310 / #300) - a crash that appears
 * only with the data that triggers it. `rules-of-hooks` proves the order
 * statically. Nothing else is enabled: style is the formatter's, and every rule
 * here has to be one that is never wrong.
 *
 * It also reads a function named `use...` as a hook, so a plain function must not
 * be named like one (`adoptLocalPath`, not `useLocalPath`).
 */

import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

export default [
    { ignores: [".next/**", "node_modules/**", "public/**", "dist/**"] },
    {
        files: ["src/**/*.{ts,tsx}", "test/**/*.{ts,tsx}"],
        languageOptions: {
            parser: tsParser,
            parserOptions: { ecmaFeatures: { jsx: true } }
        },
        // Comments elsewhere in the code silence rules from linters this project
        // does not run (Next's, jsx-a11y's), and the one rule here is never to be
        // switched off by a comment - so inline configuration is not read at all
        // (each such comment is a warning, which `npm run lint` runs `--quiet` past).
        linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "off" },
        plugins: { "react-hooks": reactHooks },
        rules: { "react-hooks/rules-of-hooks": "error" }
    }
];
