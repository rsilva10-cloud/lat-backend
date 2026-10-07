/**
 * client.js
 * ---------
 * LAT Apparel supplier integration over PromoStandards (SOAP 1.1,
 * document/literal). Request layouts follow LAT's own XSD files exactly
 * (element names, order, namespaces) — each builder below was validated
 * against those schemas. Auth is in the request body (id + password), not a
 * header, which is how PromoStandards works.
 *
 * Verified from LAT's schemas: Inventory 2.0.0 (getInventoryLevels),
 * Product Data 2.0.0 (getProductSellable), Pricing & Configuration 1.0.0
 * (getConfigurationAndPricing).
 * NOT verified (no schema provided yet): getFobPoints — built from the
 * PromoStandards standard, so expect it may need adjusting after the first
 * real call.
 *
 * Never put the request body in an error message or log: it contains the
 * password. Errors below only ever include response text.
 */

const https = require("https");
const http = require("http");
const { XMLParser } = require("fast-xml-parser");

const DEFAULT_BASE_URL = "https://promostandards.latapparel.com/live";

const SERVICES = {
  inventory: {
    path: "/inventory2.php",
    action: "getInventoryLevels",
    ns: "http://www.promostandards.org/WSDL/Inventory/2.0.0/",
    shared: "http://www.promostandards.org/WSDL/Inventory/2.0.0/SharedObjects/",
    version: "2.0.0",
  },
  productData: {
    path: "/productData.php",
    action: "getProductSellable",
    ns: "http://www.promostandards.org/WSDL/ProductDataService/2.0.0/",
    shared: "http://www.promostandards.org/WSDL/ProductDataService/2.0.0/SharedObjects/",
    version: "2.0.0",
  },
  pricing: {
    path: "/productPricingAndConfig.php",
    action: "getConfigurationAndPricing",
    ns: "http://www.promostandards.org/WSDL/PricingAndConfiguration/1.0.0/",
    shared: "http://www.promostandards.org/WSDL/PricingAndConfiguration/1.0.0/SharedObjects/",
    version: "1.0.0",
  },
};

// Purchase Order 1.0.0 (from LAT's WSDL: purchaseOrder.php, operations getSupportedOrderTypes and sendPO).
SERVICES.purchaseOrder = {
  path: "/purchaseOrder.php",
  action: "getSupportedOrderTypes",
  ns: "http://www.promostandards.org/WSDL/PO/1.0.0/",
  shared: "http://www.promostandards.org/WSDL/PO/1.0.0/SharedObjects/",
  version: "1.0.0",
};

const PRICE_TYPES = ["Customer", "List", "Net"]; // from LAT's schema
const baseUrl = () => (process.env.LAT_PS_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");

// Trimmed: a stray space or newline pasted into a Render env var is an easy
// way to get "authentication failed" with a perfectly good password.
function requireEnv(name) {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// ---------- request building ----------

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}

// <shar:name>value</shar:name> — children of every request are elements
// from the *shared* namespace (the schemas reference them with ref=).
const tag = (name, value) => `<shar:${name}>${esc(value)}</shar:${name}>`;
const arrayOf = (wrapper, itemName, values) =>
  values && values.length ? `<shar:${wrapper}>${values.map((v) => tag(itemName, v)).join("")}</shar:${wrapper}>` : "";

// The id/password pair every PromoStandards request opens with.
function credentials(svc) {
  const id = requireEnv("LAT_PS_ID");
  const password = (process.env.LAT_PS_PASSWORD || "").trim(); // optional per the schema
  return tag("wsVersion", svc.version) + tag("id", id) + (password ? tag("password", password) : "");
}

function requestElement(svc, name, inner) {
  return `<ns:${name} xmlns:ns="${svc.ns}" xmlns:shar="${svc.shared}">${inner}</ns:${name}>`;
}

function envelope(bodyXml) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header/>` +
    `<soapenv:Body>${bodyXml}</soapenv:Body></soapenv:Envelope>`
  );
}

// Element order below matches each request XSD's <xsd:sequence> — order is
// enforced by the schema, so don't rearrange.

function buildInventoryRequest({ productId, partIds, sizes, colors }) {
  const svc = SERVICES.inventory;
  const filterParts = arrayOf("partIdArray", "partId", partIds) + arrayOf("LabelSizeArray", "labelSize", sizes) + arrayOf("PartColorArray", "partColor", colors);
  const filter = filterParts ? `<shar:Filter>${filterParts}</shar:Filter>` : "";
  return requestElement(svc, "GetInventoryLevelsRequest", credentials(svc) + tag("productId", productId) + filter);
}

function buildSellableRequest({ productId, partId } = {}) {
  const svc = SERVICES.productData;
  return requestElement(
    svc,
    "GetProductSellableRequest",
    credentials(svc) +
      tag("localizationCountry", "US") +
      tag("localizationLanguage", "en") +
      (productId ? tag("productId", productId) : "") +
      (partId ? tag("partId", partId) : "") +
      tag("isSellable", "true")
  );
}

function buildPricingRequest({ productId, partId, fobId, priceType, currency = "USD" }) {
  const svc = SERVICES.pricing;
  return requestElement(
    svc,
    "GetConfigurationAndPricingRequest",
    credentials(svc) +
      tag("productId", productId) +
      (partId ? tag("partId", partId) : "") +
      tag("currency", currency) +
      tag("fobId", fobId) +
      tag("priceType", priceType) +
      tag("localizationCountry", "US") +
      tag("localizationLanguage", "en") +
      tag("configurationType", "Blank") // we buy blanks, not decorated goods
  );
}

// UNVERIFIED layout (see file header).
function buildFobPointsRequest({ productId }) {
  const svc = { ...SERVICES.pricing, action: "getFobPoints" };
  return requestElement(svc, "GetFobPointsRequest", credentials(svc) + tag("productId", productId) + tag("localizationCountry", "US") + tag("localizationLanguage", "en"));
}

// ---------- transport ----------

function post(service, action, bodyXml, timeoutMs = 30000) {
  const url = new URL(baseUrl() + service.path);
  const transport = url.protocol === "http:" ? http : https;
  const payload = envelope(bodyXml);
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          "Content-Length": Buffer.byteLength(payload),
          SOAPAction: `"${action}"`,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("error", (err) => reject(new Error(`Couldn't reach LAT: ${err.message}`)));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`LAT didn't respond within ${Math.round(timeoutMs / 1000)}s`));
    });
    req.write(payload);
    req.end();
  });
}

// ---------- response parsing ----------

// Tags that can repeat: always parsed as arrays so a single item and
// several items look the same to the code below.
const ARRAY_TAGS = new Set(["ServiceMessage", "ProductSellable", "PartInventory", "InventoryLocation", "FutureAvailability", "Part", "PartPrice", "Fob"]);

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true, // match by local name; the server's prefixes don't matter
  parseTagValue: false, // keep everything a string so IDs like "00123" survive
  trimValues: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const bool = (v) => (v == null ? null : String(v).toLowerCase() === "true" || v === "1");

// Returns the SOAP Body's contents, or throws on a SOAP fault / non-SOAP reply.
function parseBody({ status, text }) {
  let doc;
  try {
    doc = parser.parse(text);
  } catch {
    throw new Error(`LAT returned an unreadable reply (HTTP ${status}): ${text.slice(0, 200)}`);
  }
  const body = doc?.Envelope?.Body;
  if (!body) throw new Error(`LAT returned a non-SOAP reply (HTTP ${status}): ${text.slice(0, 200)}`);
  if (body.Fault) {
    const f = body.Fault;
    throw new Error(`LAT SOAP fault: ${f.faultstring || f.Reason?.Text || "unknown"}${f.faultcode ? ` (${f.faultcode})` : ""}`);
  }
  return body;
}

// LAT wraps its replies in <ResponseDataset> rather than the response
// element its own schema names (seen in a real reply). So use the expected
// name if it's there, otherwise whatever single element the Body holds —
// and if neither, say what LAT actually sent.
function responseOf(body, expectedName) {
  // An element that is present but empty (e.g. "no results") parses as "" —
  // that is a valid, empty answer, not a missing one.
  if (Object.prototype.hasOwnProperty.call(body, expectedName)) return body[expectedName] && typeof body[expectedName] === "object" ? body[expectedName] : {};
  const resp = Object.values(body).find((v) => v && typeof v === "object");
  if (!resp) throw new Error(`LAT's reply had no ${expectedName} (it sent: ${Object.keys(body).join(", ") || "nothing"})`);
  return resp;
}

function messagesOf(resp) {
  return toArray(resp?.ServiceMessageArray?.ServiceMessage).map((m) => ({
    code: num(m.code),
    severity: m.severity || null,
    description: m.description || null,
  }));
}

const describeMessages = (msgs) => msgs.map((m) => `${m.code ?? "?"}: ${m.description ?? "no description"}`).join("; ");

const quantityOf = (q) => ({ value: num(q?.Quantity?.value ?? q?.value), uom: q?.Quantity?.uom ?? q?.uom ?? null });

function normalizeInventory(body) {
  const resp = responseOf(body, "GetInventoryLevelsResponse");
  const messages = messagesOf(resp);
  if (!resp.Inventory) {
    if (messages.some((m) => m.severity === "Error")) throw new Error(`LAT inventory error — ${describeMessages(messages)}`);
    return { productId: null, parts: [], messages };
  }
  const parts = toArray(resp.Inventory.PartInventoryArray?.PartInventory).map((p) => {
    const locations = toArray(p.InventoryLocationArray?.InventoryLocation).map((loc) => ({
      id: loc.inventoryLocationId ?? null,
      name: loc.inventoryLocationName ?? null,
      postalCode: loc.postalCode ?? null,
      country: loc.country ?? null,
      quantity: quantityOf(loc.inventoryLocationQuantity).value,
      future: toArray(loc.FutureAvailabilityArray?.FutureAvailability).map((f) => ({
        quantity: quantityOf(f).value,
        availableOn: f.availableOn ?? null,
      })),
    }));
    const quantityAvailable = quantityOf(p.quantityAvailable);
    const futureEntries = locations.flatMap((l) => l.future).filter((f) => f.quantity);
    const dates = futureEntries.map((f) => f.availableOn).filter(Boolean).sort();
    return {
      partId: p.partId,
      mainPart: bool(p.mainPart),
      color: p.partColor ?? null,
      size: p.labelSize ?? null,
      description: p.partDescription ?? null,
      quantityAvailable: quantityAvailable.value,
      uom: quantityAvailable.uom,
      manufacturedItem: bool(p.manufacturedItem),
      buyToOrder: bool(p.buyToOrder),
      replenishmentLeadTimeDays: num(p.replenishmentLeadTime),
      lastModified: p.lastModified ?? null,
      locations,
      // What the catalog sync will use: available now, arriving later, and
      // the earliest arrival date.
      summary: {
        onHand: quantityAvailable.value ?? locations.reduce((s, l) => s + (l.quantity || 0), 0),
        incoming: futureEntries.reduce((s, f) => s + f.quantity, 0),
        nextAvailableOn: dates[0] ?? null,
      },
    };
  });
  return { productId: resp.Inventory.productId, stats: inventoryStats(parts), parts, messages };
}

// A compact picture of a whole style's inventory, so one lookup answers the
// questions that matter without reading hundreds of parts: what part IDs
// look like, which warehouses LAT has and how full they are, whether
// quantities pile up at a ceiling (many parts at the same top number), whether
// arrival dates and lead times are actually filled in.
function inventoryStats(parts) {
  const locations = {};
  const colors = new Set();
  const sizes = new Set();
  const lead = new Map();
  const futureDates = [];
  const futureSamples = [];
  let futureEntries = 0, partsWithLead = 0, buyToOrder = 0, manufactured = 0;

  parts.forEach((p) => {
    if (p.color) colors.add(p.color);
    if (p.size) sizes.add(p.size);
    if (p.buyToOrder) buyToOrder += 1;
    if (p.manufacturedItem) manufactured += 1;
    if (p.replenishmentLeadTimeDays != null) {
      partsWithLead += 1;
      lead.set(p.replenishmentLeadTimeDays, (lead.get(p.replenishmentLeadTimeDays) || 0) + 1);
    }
    p.locations.forEach((l) => {
      const s = (locations[l.id] = locations[l.id] || { name: l.name, rows: 0, zero: 0, max: 0, atMax: 0, total: 0 });
      const q = l.quantity || 0;
      s.rows += 1;
      s.total += q;
      if (q === 0) s.zero += 1;
      if (q > s.max) s.max = q;
      l.future.forEach((f) => {
        futureEntries += 1;
        if (f.availableOn) futureDates.push(f.availableOn);
        if (futureSamples.length < 5) futureSamples.push({ partId: p.partId, location: l.id, quantity: f.quantity, availableOn: f.availableOn });
      });
    });
  });
  parts.forEach((p) => p.locations.forEach((l) => { if ((l.quantity || 0) === locations[l.id].max) locations[l.id].atMax += 1; }));
  futureDates.sort();

  return {
    partCount: parts.length,
    idSamples: parts.slice(0, 5).map((p) => p.partId),
    colorCount: colors.size,
    colors: [...colors].slice(0, 40),
    sizes: [...sizes],
    locations,
    futureAvailability: { entries: futureEntries, withDates: futureDates.length, earliest: futureDates[0] ?? null, latest: futureDates[futureDates.length - 1] ?? null, samples: futureSamples },
    partsWithLeadTime: partsWithLead,
    leadTimeDaysCounts: Object.fromEntries([...lead.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)),
    buyToOrder,
    manufacturedItem: manufactured,
  };
}

function normalizeSellable(body) {
  const resp = responseOf(body, "GetProductSellableResponse");
  const messages = messagesOf(resp);
  const items = toArray(resp.ProductSellableArray?.ProductSellable).map((s) => ({
    productId: s.productId,
    partId: s.partId ?? null,
    culturePoint: s.culturePoint ?? null,
  }));
  if (items.length === 0 && messages.some((m) => m.severity === "Error")) throw new Error(`LAT product error — ${describeMessages(messages)}`);
  return { items, productIds: [...new Set(items.map((i) => i.productId))], messages };
}

function normalizePricing(body) {
  const resp = responseOf(body, "GetConfigurationAndPricingResponse");
  if (resp.ErrorMessage) throw new Error(`LAT pricing error ${resp.ErrorMessage.code ?? "?"}: ${resp.ErrorMessage.description ?? "no description"}`);
  const messages = messagesOf(resp);
  if (!resp.Configuration && messages.some((m) => m.severity === "Error")) throw new Error(`LAT pricing error — ${describeMessages(messages)}`);
  const c = resp.Configuration;
  if (!c) return { productId: null, currency: null, priceType: null, fobs: [], parts: [] };
  return {
    productId: c.productId,
    currency: c.currency ?? null,
    priceType: c.priceType ?? null,
    fobs: toArray(c.FobArray?.Fob).map((f) => ({ fobId: f.fobId, postalCode: f.fobPostalCode ?? null })),
    parts: toArray(c.PartArray?.Part).map((p) => ({
      partId: p.partId,
      description: p.partDescription ?? null,
      prices: toArray(p.PartPriceArray?.PartPrice).map((pp) => ({
        minQuantity: num(pp.minQuantity),
        price: num(pp.price),
        uom: pp.priceUom ?? null,
        effectiveDate: pp.priceEffectiveDate || null,
        expiryDate: pp.priceExpiryDate || null,
      })),
    })),
  };
}

// FOB points: layout unverified, so collect every object that has a fobId
// instead of assuming where it sits.
function normalizeFobPoints(body) {
  const found = [];
  const walk = (node) => {
    if (node && typeof node === "object") {
      if (!Array.isArray(node) && node.fobId != null) found.push(node);
      Object.values(node).forEach(walk);
    }
  };
  walk(body);
  const errors = [];
  const collectErrors = (node) => {
    if (node && typeof node === "object") {
      if (node.ErrorMessage) errors.push(node.ErrorMessage);
      toArray(node.ServiceMessage).filter((m) => m.severity === "Error").forEach((m) => errors.push(m));
      Object.values(node).forEach(collectErrors);
    }
  };
  collectErrors(body);
  if (found.length === 0 && errors.length) throw new Error(`LAT FOB error ${errors[0].code ?? "?"}: ${errors[0].description ?? "no description"}`);
  return { fobs: found };
}

// ---------- public operations ----------
// Pass { raw: true } to get LAT's reply XML back instead of the normalized
// form — for debugging field-name surprises on first contact.

async function run(service, action, bodyXml, normalize, { raw = false, timeoutMs } = {}) {
  const reply = await post(service, action, bodyXml, timeoutMs);
  if (raw) return { status: reply.status, raw: reply.text };
  return normalize(parseBody(reply));
}

const getInventoryLevels = (args, opts) => run(SERVICES.inventory, SERVICES.inventory.action, buildInventoryRequest(args), normalizeInventory, opts);
// The full sellable list can be large, so give it more time than a lookup.
const getSellableProducts = (args = {}, opts = {}) => run(SERVICES.productData, SERVICES.productData.action, buildSellableRequest(args), normalizeSellable, { timeoutMs: 60000, ...opts });
const getPricing = (args, opts) => {
  if (!PRICE_TYPES.includes(args.priceType)) throw new Error(`priceType must be one of: ${PRICE_TYPES.join(", ")}`);
  return run(SERVICES.pricing, SERVICES.pricing.action, buildPricingRequest(args), normalizePricing, opts);
};
const getFobPoints = (args, opts) => run(SERVICES.pricing, "getFobPoints", buildFobPointsRequest(args), normalizeFobPoints, opts);

// Plumbing shared with po.js (kept separate so ordering code stays in one place).
const _shared = { SERVICES, tag, esc, credentials, requestElement, post, parseBody, responseOf, messagesOf, describeMessages, toArray, num };

module.exports = {
  _shared,
  getInventoryLevels,
  getSellableProducts,
  getPricing,
  getFobPoints,
  PRICE_TYPES,
  // exported for tests
  _internal: { post, SERVICES, buildInventoryRequest, buildSellableRequest, buildPricingRequest, buildFobPointsRequest, envelope, parseBody, normalizeInventory, normalizeSellable, normalizePricing, normalizeFobPoints, esc },
};
