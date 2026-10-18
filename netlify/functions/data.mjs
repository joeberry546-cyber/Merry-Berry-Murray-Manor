// House Log data API, stored as one JSON document in Netlify Blobs.
// Writes use ETag compare-and-set, so two people saving at once can't overwrite each other.
import { getStore } from "@netlify/blobs";
import { timingSafeEqual } from "node:crypto";

export const config = { path: "/api/data" };

const KEY = "house-log";
const TABLES = ["contacts", "projects", "maintenance"];
const REQUIRED = { contacts: "name", projects: "title", maintenance: "name" };

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function authorized(req) {
  const expected = Netlify.env.get("HOUSELOG_PASSWORD");
  if (!expected) return null; // not configured
  const given = req.headers.get("x-house-key") || "";
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const valid = (d) => d && typeof d === "object" && TABLES.every((t) => Array.isArray(d[t]));

// Returns an error message, or null when the change was applied to `db` in place.
function apply(db, body) {
  const { op, table: t, payload, filter } = body;
  if (TABLES.indexOf(t) < 0) return "Unknown table " + t;
  const rows = db[t];
  const hit = (r) => !filter || r[filter[0]] === filter[1];

  if (op === "insert") {
    const list = Array.isArray(payload) ? payload : [payload];
    for (const item of list) {
      if (!item || typeof item !== "object") return "Bad row.";
      const r = { ...item };
      if (!r.id) return "Row needs an id.";
      if (!r[REQUIRED[t]]) return "Missing " + REQUIRED[t] + ".";
      if (rows.some((x) => x.id === r.id)) return "Duplicate id.";
      if (r.is_example === undefined) r.is_example = false;
      rows.push(r);
    }
    return null;
  }
  if (op === "update") {
    if (!filter) return "Update needs a filter.";
    if (!payload || typeof payload !== "object") return "Bad update.";
    rows.forEach((r) => { if (hit(r)) Object.assign(r, payload); });
    return null;
  }
  if (op === "delete") {
    if (!filter) return "Delete needs a filter.";
    const gone = rows.filter(hit).map((r) => r.id);
    db[t] = rows.filter((r) => !hit(r));
    if (t === "contacts") { // same as "on delete set null"
      db.projects.forEach((p) => { if (gone.includes(p.contractor_id)) p.contractor_id = null; });
      db.maintenance.forEach((m) => { if (gone.includes(m.contact_id)) m.contact_id = null; });
    }
    return null;
  }
  return "Unsupported operation.";
}

export default async (req) => {
  const ok = authorized(req);
  if (ok === null) return json({ error: "Server isn't set up: add a HOUSELOG_PASSWORD environment variable in Netlify." }, 500);
  if (!ok) return json({ error: "unauthorized" }, 401);

  const store = getStore({ name: "house-log", consistency: "strong" });

  if (req.method === "GET") {
    const entry = await store.getWithMetadata(KEY, { type: "json" });
    if (!entry) return json({ empty: true });
    return json({ etag: entry.etag, data: entry.data });
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad JSON." }, 400); }

  // First-ever save: only succeeds if nothing exists yet.
  if (body.op === "init") {
    if (!valid(body.payload)) return json({ error: "Not a valid House Log." }, 400);
    const res = await store.setJSON(KEY, body.payload, { onlyIfNew: true });
    return json({ ok: true, created: !!res.modified });
  }

  // Replace everything (used by "Restore from backup").
  if (body.op === "replace") {
    if (!valid(body.payload)) return json({ error: "Not a valid House Log." }, 400);
    await store.setJSON(KEY, body.payload);
    return json({ ok: true });
  }

  // Row-level changes, retried if someone else saved at the same moment.
  for (let attempt = 0; attempt < 6; attempt++) {
    const entry = await store.getWithMetadata(KEY, { type: "json" });
    if (!entry || !valid(entry.data)) return json({ error: "No data yet — reload the page." }, 409);
    const err = apply(entry.data, body);
    if (err) return json({ error: err }, 400);
    const res = await store.setJSON(KEY, entry.data, { onlyIfMatch: entry.etag });
    if (res.modified) return json({ ok: true });
  }
  return json({ error: "Busy — please try again." }, 409);
};
