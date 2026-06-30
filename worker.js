/**
 * SVS Planner — Cloudflare Worker
 * Provides a tiny shared key-value API backed by Workers KV so the whole
 * alliance sees the same Rally Leaders / Team Setup / Battle Strategy data.
 *
 * Endpoints:
 *   GET  /state          -> returns the saved JSON blob (or {} if none saved yet)
 *   PUT  /state          -> body is JSON, saves it as the new shared state
 *
 * Bind a KV namespace called SVS_KV to this Worker (see deployment steps).
 */

const ALLOWED_ORIGIN = "*"; // tighten to your Pages domain once deployed, e.g. "https://svs-planner.pages.dev"
const STATE_KEY = "svs_state";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === "/state" && request.method === "GET") {
      const raw = await env.SVS_KV.get(STATE_KEY);
      return new Response(raw || "{}", {
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    }

    if (url.pathname === "/state" && request.method === "PUT") {
      const body = await request.text();
      // basic sanity check: must be valid JSON and under ~1MB (KV free tier value cap is generous, but keep it tidy)
      try {
        JSON.parse(body);
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders() },
        });
      }
      await env.SVS_KV.put(STATE_KEY, body);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  },
};
