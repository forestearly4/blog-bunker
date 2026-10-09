/**
 * netlify/lib/metering.js
 * Word-allowance check + recording for server-side AI calls that aren't
 * routed through claude-proxy.js (the Chrome extension summarizer).
 * Mirrors claude-proxy.js exactly — keep WORD_CAPS in sync with it and with
 * TIER_CONFIG in dashboard.jsx.
 */
export const WORD_CAPS = { scout: 15000, operative: 60000 };
export const TOKENS_PER_WORD = 1.333;

export async function checkAllowance(store, userId, period = new Date().toISOString().slice(0, 7)) {
  const tier = (await store.get(`${userId}:user_tier`, { type: "json" })) || "scout";
  const topUp = ((await store.get(`${userId}:topup_words_${period}`, { type: "json" })) || { amount: 0 }).amount;
  const cap = (WORD_CAPS[tier] || WORD_CAPS.scout) + topUp;
  const usage = (await store.get(`${userId}:usage_text_${period}`, { type: "json" })) || { tokens: 0 };
  const ok = (usage.tokens || 0) < Math.round(cap * TOKENS_PER_WORD);
  return { ok, cap };
}

export async function recordUsage(store, userId, tokens, period = new Date().toISOString().slice(0, 7)) {
  if (!tokens || tokens <= 0) return;
  const usage = (await store.get(`${userId}:usage_text_${period}`, { type: "json" })) || { tokens: 0 };
  await store.setJSON(`${userId}:usage_text_${period}`, { tokens: (usage.tokens || 0) + tokens });
}
