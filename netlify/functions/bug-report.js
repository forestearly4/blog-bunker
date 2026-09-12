/**
 * netlify/functions/bug-report.js
 * Lets any logged-in user (beta testers especially) submit a bug report
 * without needing to manually screenshot the console and send it over chat.
 *
 * POST /api/bug-report   { userId, description, context }  → save a report
 * GET  /api/bug-report                                      → list all reports (Forest's own review)
 */

import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type":                 "application/json",
};

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const store = getStore("bug-reports");

  if (req.method === "POST") {
    try {
      const { userId, description, context } = await req.json();
      if (!description?.trim()) {
        return new Response(JSON.stringify({ error: "description required" }), { status: 400, headers: CORS });
      }
      const id = `report_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const report = {
        id,
        userId: userId || "anonymous",
        description: description.trim(),
        context: context || {},
        submittedAt: new Date().toISOString(),
      };
      await store.setJSON(id, report);
      return new Response(JSON.stringify({ success: true, id }), { status: 200, headers: CORS });
    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
    }
  }

  if (req.method === "GET") {
    try {
      const { blobs } = await store.list();
      const reports = await Promise.all(
        blobs.map(async (b) => {
          try { return await store.get(b.key, { type: "json" }); }
          catch { return null; }
        })
      );
      const valid = reports.filter(Boolean).sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
      return new Response(JSON.stringify({ reports: valid }), { status: 200, headers: CORS });
    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: CORS });
};
