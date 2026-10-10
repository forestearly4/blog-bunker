import { test, expect } from "@playwright/test";
import { handle } from "../../netlify/functions/ext.js";

// Server-side guard: summarizing the same article text twice must cost the
// user's word allowance once (re-opening the popup, a second browser, a
// double click) — unless they explicitly ask for a fresh summary.
test("the same article text is only charged once; fresh:true re-runs it", async () => {
  const mem = new Map();
  const store = {
    async get(k) { return mem.has(k) ? JSON.parse(mem.get(k)) : null; },
    async setJSON(k, v) { mem.set(k, JSON.stringify(v)); },
    async delete(k) { mem.delete(k); },
    async list({ prefix }) { return { blobs: [...mem.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })) }; },
  };
  let aiCalls = 0;
  const ai = async () => { aiCalls++; return { text: JSON.stringify({ tldr: `T${aiCalls}`, key_points: ["a"], angles: ["b"], tags: [] }), tokens: 500 }; };
  const call = async (b) => { const r = await handle(new Request("http://x/api/ext", { method: "POST", body: JSON.stringify(b) }), { store, ai }); return { status: r.status, ...(await r.json()) }; };

  const { token } = await call({ action: "createToken", userId: "u@x.com", operative: true });
  const text = "tight line nymphing keeps you in contact ".repeat(40);
  const period = new Date().toISOString().slice(0, 7);
  const used = () => JSON.parse(mem.get(`u@x.com:usage_text_${period}`) || '{"tokens":0}').tokens;

  const first = await call({ action: "summarize", token, text, title: "Euro" });
  expect(first.summary.tldr).toBe("T1");
  expect(first.cached).toBeUndefined();

  const second = await call({ action: "summarize", token, text, title: "Euro" });
  expect(second.cached).toBe(true);
  expect(second.summary.tldr).toBe("T1");
  expect(aiCalls).toBe(1);
  expect(used()).toBe(500);

  const fresh = await call({ action: "summarize", token, text, title: "Euro", fresh: true });
  expect(fresh.summary.tldr).toBe("T2");
  expect(aiCalls).toBe(2);
  expect(used()).toBe(1000);
});
