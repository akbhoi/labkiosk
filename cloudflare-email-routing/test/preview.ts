/**
 * `pnpm run preview [directory]`: write every template as an HTML file (and an
 * index of them) to look at in a browser. Tests check the markup; this is how
 * a change to a template is seen. The default directory, `previews/`, is not
 * committed.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderMailHtml } from "../src/templates";
import { BRAND, SAMPLES } from "./samples";

const out = resolve(process.argv[2] || "previews");
mkdirSync(out, { recursive: true });
for (const sample of SAMPLES) {
  const html = renderMailHtml({ template: sample.template, subject: sample.subject, text: sample.text, brand: BRAND });
  writeFileSync(join(out, `${sample.file}.html`), html, "utf8");
}
const links = SAMPLES.map((s) => `<li><a href="${s.file}.html">${s.file}</a> (${s.template.name})</li>`).join("\n");
writeFileSync(join(out, "index.html"), `<!DOCTYPE html><meta charset="utf-8"><title>Email templates</title><ul>\n${links}\n</ul>\n`, "utf8");
console.log(`Wrote ${SAMPLES.length} previews to ${out}`);
