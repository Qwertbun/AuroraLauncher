import { esbuildDecorators } from "@aurora-launcher/esbuild-decorators";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { context } from "esbuild";
import minimist from "minimist";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { _, watch, prod, ...args } = minimist(process.argv.slice(2));

if (prod) {
    args.minify = true;
    args.sourcesContent = false;
    args.sourcemap = "inline";
} else {
    args.sourcemap = true;
}

if (!watch) {
    console.log("Build...");
    console.time("Build successfully");
}

const skipSwcForNodeModules = {
    name: "skip-swc-for-node-modules",
    setup(build) {
        build.onLoad({ filter: /\.[jt]sx?$/ }, async (args) => {
            const normalizedPath = path.normalize(args.path);
            if (!normalizedPath.includes(`${path.sep}node_modules${path.sep}`)) {
                return;
            }

            const extension = path.extname(normalizedPath).toLowerCase();
            const loaderMap = {
                ".js": "js",
                ".jsx": "jsx",
                ".ts": "ts",
                ".tsx": "tsx",
            };

            return {
                contents: await readFile(normalizedPath, "utf8"),
                loader: loaderMap[extension] ?? "js",
            };
        });
    },
};

const ctx = await context({
    platform: "node",
    target: "node20",
    bundle: true,
    external: [
        "@azure/app-configuration",
        "@azure/keyvault-secrets",
        "oci-common",
        "oci-objectstorage",
        "oci-secrets",
        "oracledb",
    ],
    plugins: [skipSwcForNodeModules, esbuildDecorators()],
    entryPoints: ["src/app.ts"],
    outfile: "dist/LauncherServer.js",
    ...args,
}).catch(() => process.exit(1));

if (watch) {
    console.log("Watching...");
    await ctx.watch();
} else {
    await ctx.rebuild();
    await ctx.dispose();
    console.timeEnd("Build successfully");
}
