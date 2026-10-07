require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { requireAuth } = require("./sessionAuth");
const { getInventoryLevels, getSellableProducts, getPricing, getFobPoints, PRICE_TYPES } = require("./client");
const { getSupportedOrderTypes, previewPurchaseOrder, sendPurchaseOrder, listLatOrders, resolveLatOrder } = require("./po");

const app = express();

// Same safety net as the other backends: one odd failure shouldn't take the
// whole service down for the team.
process.on("unhandledRejection", (err) => console.error("Unhandled rejection (server kept running):", err));
process.on("uncaughtException", (err) => console.error("Uncaught exception (server kept running):", err));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
app.use(cors({ origin: allowedOrigins.includes("*") ? true : allowedOrigins }));

app.use(express.json({ limit: "100kb" }));
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "That request wasn't valid JSON." });
  next(err);
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

// Wraps a handler so any failure becomes a clean 502 with LAT's own message.
// Only err.message is ever logged or returned — never the request, which
// holds the LAT password.
const route = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    // 400 your input, 403 not allowed, 409 PO already used, 422 LAT rejected it, 503 sending off / record unavailable.
    if ([400, 403, 409, 422, 503].includes(err.status)) {
      return res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}), ...(err.existing ? { existing: err.existing } : {}), ...(err.unknownOutcome ? { unknownOutcome: true } : {}) });
    }
    if (err.unknownOutcome) return res.status(502).json({ error: err.message, unknownOutcome: true });
    console.error("LAT request failed:", err.message);
    res.status(502).json({ error: err.message || "LAT request failed" });
  }
};

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const clean = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 64) : undefined);
const list = (v) => (typeof v === "string" && v.trim() ? v.split(",").map((s) => s.trim().slice(0, 64)).filter(Boolean) : undefined);
const wantsRaw = (req) => req.query.raw === "1";

// Every sellable style/part LAT will take orders for. No productId = all of
// them (can be large); pass productId to look at one style.
app.get("/api/lat/sellable", requireAuth, route((req) =>
  getSellableProducts({ productId: clean(req.query.productId), partId: clean(req.query.partId) }, { raw: wantsRaw(req) })
));

// Stock per part, per LAT warehouse, with future arrival dates and lead time.
// One style at a time, because that's how the PromoStandards inventory
// service works. Optional filters: partIds, sizes, colors (comma-separated).
app.get("/api/lat/inventory", requireAuth, route((req) => {
  const productId = clean(req.query.productId);
  if (!productId) throw badRequest("productId is required");
  return getInventoryLevels(
    { productId, partIds: list(req.query.partIds), sizes: list(req.query.sizes), colors: list(req.query.colors) },
    { raw: wantsRaw(req) }
  );
}));

// Quantity-break pricing for blanks. fobId and priceType are required by
// LAT's schema; use /api/lat/fob-points to find valid fobIds.
app.get("/api/lat/pricing", requireAuth, route((req) => {
  const productId = clean(req.query.productId);
  const fobId = clean(req.query.fobId);
  const priceType = clean(req.query.priceType);
  if (!productId) throw badRequest("productId is required");
  if (!fobId) throw badRequest("fobId is required (see /api/lat/fob-points)");
  if (!PRICE_TYPES.includes(priceType)) throw badRequest(`priceType must be one of: ${PRICE_TYPES.join(", ")}`);
  return getPricing({ productId, partId: clean(req.query.partId), fobId, priceType }, { raw: wantsRaw(req) });
}));

// UNVERIFIED against LAT's schema (not provided) — see client.js.
app.get("/api/lat/fob-points", requireAuth, route((req) => {
  const productId = clean(req.query.productId);
  if (!productId) throw badRequest("productId is required");
  return getFobPoints({ productId }, { raw: wantsRaw(req) });
}));

// ---------- Purchase orders ----------

// Read-only. Shows whether your login can use LAT's Purchase Order service
// and which order types LAT accepts. Changes nothing at LAT.
app.get("/api/lat/po/order-types", requireAuth, route(() => getSupportedOrderTypes()));

// Checks an order against LAT's limits and returns the exact request that
// would be sent, with the login shown as a placeholder. Sends nothing.
app.post("/api/lat/po/preview", requireAuth, route((req) => previewPurchaseOrder(req.body)));

// SENDS A REAL ORDER (LAT has no test mode). Off unless LAT_PO_SEND_ENABLED=true. Needs the order
// plus confirmPoNumber (the PO number typed again). See po.js for the full set of safeguards.
app.post("/api/lat/po/send", requireAuth, route((req) => sendPurchaseOrder(req.body, { user: req.user, authHeader: req.headers.authorization })));

// The shared record of orders sent from the app, and (admins only) settling one that's stuck.
app.get("/api/lat/po/orders", requireAuth, route((req) => listLatOrders(req.headers.authorization)));
app.post("/api/lat/po/resolve", requireAuth, route((req) => resolveLatOrder(req.body || {}, req.headers.authorization)));

const port = process.env.PORT || 3006;
app.listen(port, () => console.log(`LAT backend listening on :${port}`));
