import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "..", "shopify-reviews-cloudflare-github-deploy.zip");
execFileSync("zip", ["-qr", output, ".", "-x", "node_modules/*", ".wrangler/*", ".dev.vars", "*.zip"], { cwd: root, stdio: "inherit" });
console.log(output);
