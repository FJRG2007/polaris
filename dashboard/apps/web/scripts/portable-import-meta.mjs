/**
 * Keep the build machine's paths out of the browser bundle.
 *
 * Webpack compiles a bare `import.meta.url` to the absolute `file://` URL of the
 * module on the machine that ran the build. pdf.js reads it in its Node-only
 * canvas factory, so every client that loaded a PDF was sent the builder's disk
 * layout - the account name included - for a branch that never runs in a
 * browser. Any other dependency that reads it would do the same.
 *
 * In the client compilation this answers `import.meta.url` with the module's path
 * relative to the workspace root instead, still a `file:` URL so code that parses
 * it keeps working. `new URL("./asset", import.meta.url)` is untouched: webpack's
 * own URL handling resolves those to emitted assets before this is asked. The
 * server compilation keeps the real path, which `createRequire` needs.
 */

import { relative, sep } from "node:path";

const NAME = "PortableImportMetaUrl";

/** The stand-in for a module's `import.meta.url`: workspace-relative, never absolute. */
export function portableModuleUrl(resource, root) {
    const path = relative(root, resource).split(sep).join("/");
    const inside =
        path && !path.startsWith("../") && !/^[A-Za-z]:/.test(path) && !path.startsWith("/");
    return `file:///${inside ? path : resource.split(/[\\/]/).pop()}`;
}

/** Webpack plugin; `webpack` is the instance Next passes to its `webpack` hook. */
export class PortableImportMetaUrl {
    constructor(root, webpack) {
        this.root = root;
        this.ConstDependency = webpack.dependencies.ConstDependency;
        this.BasicEvaluatedExpression = webpack.javascript?.BasicEvaluatedExpression;
    }

    apply(compiler) {
        compiler.hooks.compilation.tap(NAME, (_compilation, { normalModuleFactory }) => {
            const handler = (parser) => {
                const urlOf = () =>
                    portableModuleUrl(parser.state.module.resource ?? "", this.root);
                parser.hooks.expression.for("import.meta.url").tap(NAME, (expression) => {
                    const dependency = new this.ConstDependency(
                        JSON.stringify(urlOf()),
                        expression.range
                    );
                    dependency.loc = expression.loc;
                    parser.state.module.addPresentationalDependency(dependency);
                    return true;
                });
                // Constant folding (`import.meta.url ? a : b`, comparisons) reads the
                // evaluated value, so it has to be the portable one too.
                if (this.BasicEvaluatedExpression) {
                    parser.hooks.evaluateIdentifier
                        .for("import.meta.url")
                        .tap(NAME, (expression) =>
                            new this.BasicEvaluatedExpression()
                                .setString(urlOf())
                                .setRange(expression.range)
                        );
                }
            };
            for (const type of ["javascript/auto", "javascript/esm", "javascript/dynamic"]) {
                normalModuleFactory.hooks.parser.for(type).tap(NAME, handler);
            }
        });
    }
}
