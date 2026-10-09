import { test, expect, chromium } from "@playwright/test";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { handle } from "../../netlify/functions/ext.js";

// End-to-end check of the REAL extension (loaded unpacked into Chromium)
// talking to the REAL /api/ext handler (in-memory store, fake AI): pair,
// read an article from a live page, summarize, save into a chosen workspace.
const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../extension");
const extId = [...createHash("sha256").update(EXT_DIR).digest("hex").slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join("");

const ARTICLE = `<!doctype html><html><head><title>Why Euro Nymphing Wins</title><meta property="og:site_name" content="Hatch"></head><body>
<nav>SITE MENU JUNK LINK LINK LINK</nav>
<article><h1>Why Euro Nymphing Wins</h1>${"<p>Tight line nymphing keeps you in direct contact with the flies on cold spring rivers every single time. </p>".repeat(20)}</article>
<footer>FOOTER JUNK</footer></body></html>`;

test("extension pairs, summarizes the page being read, and saves to the chosen workspace", async () => {
  const mem = new Map();
  const store = {
    async get(k) { return mem.has(k) ? JSON.parse(mem.get(k)) : null; },
    async setJSON(k, v) { mem.set(k, JSON.stringify(v)); },
    async delete(k) { mem.delete(k); },
    async list({ prefix }) { return { blobs: [...mem.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })) }; },
  };
  const aiCalls = [];
  const ai = async (system, user) => { aiCalls.push(user); return { text: JSON.stringify({ tldr: "Tight lines win.", key_points: ["Stay in contact"], angles: ["Dry-fly rebuttal"], tags: [] }), tokens: 300 }; };
  mem.set("demo@blogbunker.app:workspaces", JSON.stringify([{ id: "ws_bb", name: "Blog Bunker" }]));
  mem.set("demo@blogbunker.app:ws_settings", JSON.stringify({ name: "Cask & Stream" }));

  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    if (req.url === "/article") { res.setHeader("content-type", "text/html"); return res.end(ARTICLE); }
    const r = await handle(new Request(`http://x${req.url}`, { method: req.method, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) }), { store, ai });
    res.statusCode = r.status; r.headers.forEach((v, k) => res.setHeader(k, v)); res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const tokRes = await handle(new Request("http://x/api/ext", { method: "POST", body: JSON.stringify({ action: "createToken", userId: "demo@blogbunker.app", operative: true }) }), { store, ai });
  const { token } = await tokRes.json();
  const pairing = "bbpair:" + Buffer.from(JSON.stringify({ u: base, t: token })).toString("base64");

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-ext-"));
  const ctx = await chromium.launchPersistentContext(userDir, {
    executablePath: process.env.PW_CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    headless: false,
    args: ["--headless=new", `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, "--no-sandbox"],
  });
  try {
    const articlePage = await ctx.newPage();
    await articlePage.goto(`${base}/article`);

    const popup = await ctx.newPage();
    await popup.exposeFunction("__readArticle", (src) => articlePage.evaluate(src));
    await popup.addInitScript(() => {
      chrome.tabs.query = async () => [{ id: 1, url: "https://stand-in.example/article" }];
      chrome.scripting.executeScript = async ({ func }) => [{ result: await window.__readArticle("(" + func.toString() + ")()") }];
    });
    await popup.goto(`chrome-extension://${extId}/popup.html`);

    // Pair
    await popup.getByLabel("Pairing code").fill(pairing);
    await popup.getByRole("button", { name: "Connect" }).click();
    await expect(popup.locator("#status")).toHaveText("Connected.");
    await expect(popup.locator("#workspace option")).toHaveText(["Cask & Stream", "Blog Bunker"]);
    await expect(popup.locator("#page b")).toHaveText("Why Euro Nymphing Wins");

    // Summarize: article text only, no nav/footer junk
    await popup.getByRole("button", { name: /Summarize this page/ }).click();
    await expect(popup.locator("#tldr")).toHaveText("Tight lines win.");
    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0]).toContain("Tight line nymphing");
    expect(aiCalls[0]).not.toContain("SITE MENU JUNK");
    expect(aiCalls[0]).not.toContain("FOOTER JUNK");

    // Save into the Blog Bunker workspace as Marketing inspiration
    await popup.locator("#workspace").selectOption("ws_bb");
    await popup.locator("#target").selectOption("social");
    await popup.getByRole("button", { name: "Save to Blog Bunker" }).click();
    await expect(popup.locator("#status")).toContainText("Saved");

    const inbox = [...mem.entries()].filter(([k]) => k.includes(":extinbox:")).map(([, v]) => JSON.parse(v));
    expect(inbox).toHaveLength(1);
    expect(inbox[0].workspaceId).toBe("ws_bb");
    expect(inbox[0].target).toBe("social");
    expect(inbox[0].item.title).toBe("Why Euro Nymphing Wins");
    expect(inbox[0].item.notes).toContain("Tight lines win.");

    // Words were metered against the user's allowance
    const period = new Date().toISOString().slice(0, 7);
    expect(JSON.parse(mem.get(`demo@blogbunker.app:usage_text_${period}`)).tokens).toBe(300);

    // A reopened popup is still connected (token persisted in extension storage)
    await popup.reload();
    await expect(popup.locator("#view-main")).toBeVisible();
  } finally {
    await ctx.close();
    server.close();
  }
});
