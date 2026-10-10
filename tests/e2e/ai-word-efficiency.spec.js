import { test, expect } from "@playwright/test";
import fs from "node:fs";

// Guard rail: every AI call must declare an explicit, sensible output cap so a
// new feature can't quietly fall back to a big default and drain users' words.
test("every callAI call site sets an explicit output cap (<= 4096)", () => {
  const s = fs.readFileSync("src/dashboard.jsx", "utf8");
  const bad = [];
  for (const m of s.matchAll(/(?<![\w_])callAI\(/g)) {
    const before = s.slice(Math.max(0, m.index - 20), m.index);
    if (/function\s*$/.test(before) || /\/\/.*$/.test(s.slice(s.lastIndexOf("\n", m.index), m.index))) continue;
    let i = m.index + m[0].length, d = 1, instr = null, args = [], last = i;
    while (d) {
      const c = s[i];
      if (instr) {
        if (c === "\\") i++;
        else if (c === instr) instr = null;
        else if (instr === "`" && c === "$" && s[i + 1] === "{") { let k = i + 2, dd = 1; while (dd) { if (s[k] === "{") dd++; else if (s[k] === "}") dd--; k++; } i = k - 1; }
      } else if (c === "/" && s[i + 1] === "/") { i = s.indexOf("\n", i); }
      else if ("\"'`".includes(c)) instr = c;
      else if ("([{".includes(c)) d++;
      else if (")]}".includes(c)) d--;
      else if (c === "," && d === 1) { args.push(s.slice(last, i)); last = i + 1; }
      i++;
    }
    args.push(s.slice(last, i - 1));
    const line = s.slice(0, m.index).split("\n").length;
    const cap = (args[5] || "").replace(/\/\/.*$/gm, "").trim();
    const n = Number(cap);
    const ok = cap && (Number.isFinite(n) ? n <= 4096 : /^[A-Z_]+$|Math\.min\(4000/.test(cap));
    if (!ok) bad.push(`line ${line}: ${cap || "no cap"}`);
  }
  expect(bad).toEqual([]);
});
