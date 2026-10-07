/**
 * po.js
 * -----
 * LAT Apparel Purchase Order 1.0.0 (PromoStandards). Layouts, element order,
 * limits, and allowed values follow LAT's own XSD files (SendPORequest,
 * SharedObjectsPO, ...); the builder below is validated against them in tests.
 *
 * Sending a real order is OFF unless the server sets LAT_PO_SEND_ENABLED=true.
 * LAT has no test endpoint, so every sendPO is a REAL order, and the PO
 * service has no cancel or lookup. So, on the server (not just on screen):
 *   - the PO number must be typed to confirm;
 *   - the order is checked against LAT's limits and its request is built
 *     BEFORE anything is reserved;
 *   - the PO number is reserved in the shared order record first, and if that
 *     can't be done, nothing is sent; a PO number already pending/sent/unknown
 *     is refused;
 *   - if LAT doesn't answer, the order MAY exist: the PO number stays locked
 *     until an admin resolves it.
 * Also here: a read-only access check (getSupportedOrderTypes) and a preview
 * that builds and checks the request and sends nothing.
 */

const { SERVICES, esc, credentials, requestElement, post, parseBody, responseOf, messagesOf, describeMessages, toArray } = require("./client")._shared;

// From LAT's SharedObjectsPO.xsd.
const ORDER_TYPES = ["Blank", "Configured", "Sample", "Simple"];

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

// Elements of the PO namespace use `ns:`, shared ones `shar:` (see the XSDs).
const n = (name, value) => `<ns:${name}>${esc(value)}</ns:${name}>`;
const s = (name, value) => `<shar:${name}>${esc(value)}</shar:${name}>`;
const optional = (builder, name, value) => (value === "" || value == null ? "" : builder(name, value));

const money = (x) => (Math.round(x * 100) / 100).toFixed(2);
const price = (x) => String(Number(Number(x).toFixed(4)));

/** Checks an order from the app against LAT's schema limits. Reports every problem at once. */
function validatePurchaseOrder(input) {
  const i = input && typeof input === "object" ? input : {};
  const errors = [];
  const text = (label, value, { max, required = false } = {}) => {
    const v = str(value);
    if (required && !v) errors.push(`${label} is required.`);
    else if (max && v.length > max) errors.push(`${label} is too long (${max} characters at most).`);
    return v;
  };

  const poNumber = text("The PO number", i.poNumber, { max: 64, required: true });
  const orderType = str(i.orderType === undefined ? "Blank" : i.orderType);
  if (!ORDER_TYPES.includes(orderType)) errors.push(`Order type must be one of: ${ORDER_TYPES.join(", ")}.`);
  const currency = str(i.currency === undefined ? "USD" : i.currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) errors.push("Currency must be a 3-letter code, like USD.");
  const termsAndConditions = text("Terms and conditions", i.termsAndConditions, { max: 2000, required: true });
  const paymentTerms = text("Payment terms", i.paymentTerms, { max: 200 });

  const st = i.shipTo && typeof i.shipTo === "object" ? i.shipTo : {};
  const shipTo = {
    attentionTo: text("Ship-to attention line", st.attentionTo, { max: 35 }),
    companyName: text("Ship-to company name", st.companyName, { max: 35 }),
    address1: text("Ship-to street address", st.address1, { max: 35, required: true }),
    address2: text("Ship-to address line 2", st.address2, { max: 35 }),
    city: text("Ship-to city", st.city, { max: 30, required: true }),
    region: text("Ship-to state", st.region, { max: 3, required: true }).toUpperCase(),
    postalCode: text("Ship-to ZIP", st.postalCode, { max: 10, required: true }),
    country: str(st.country === undefined ? "US" : st.country).toUpperCase(),
    email: text("Ship-to email", st.email, { max: 128 }),
    phone: text("Ship-to phone", st.phone, { max: 32 }),
  };
  if (!/^[A-Z]{2}$/.test(shipTo.country)) errors.push("Ship-to country must be a 2-letter code, like US.");
  if (shipTo.email && !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(shipTo.email)) errors.push("The ship-to email address doesn't look right.");

  const fr = i.freight && typeof i.freight === "object" ? i.freight : {};
  const freight = { carrier: text("Carrier", fr.carrier, { max: 64, required: true }), service: text("Shipping service", fr.service, { max: 64, required: true }) };

  const oc = i.orderContact && typeof i.orderContact === "object" ? i.orderContact : null;
  const orderContact = oc
    ? {
        accountName: text("Account name", oc.accountName, { max: 64 }),
        accountNumber: text("Account number", oc.accountNumber, { max: 64 }),
        attentionTo: text("Order contact name", oc.attentionTo, { max: 35 }),
        companyName: text("Order contact company", oc.companyName, { max: 35 }),
        email: text("Order contact email", oc.email, { max: 128 }),
        phone: text("Order contact phone", oc.phone, { max: 32 }),
      }
    : null;
  if (orderContact && orderContact.email && !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(orderContact.email)) errors.push("The order contact email address doesn't look right.");

  const shipmentComments = text("Shipping comments", i.shipmentComments, { max: 500 });

  const rawLines = toArray(i.lines);
  if (rawLines.length === 0) errors.push("Add at least one item to order.");
  if (rawLines.length > 100) errors.push("An order can have at most 100 lines.");
  const seen = new Set();
  const lines = rawLines.slice(0, 100).map((l, idx) => {
    const partId = str(l && l.partId);
    const label = partId || `Line ${idx + 1}`;
    if (!partId) errors.push(`Line ${idx + 1} has no part number.`);
    else if (partId.length > 64 || /\s/.test(partId)) errors.push(`${label}: the part number can't have spaces or be over 64 characters.`);
    else if (seen.has(partId)) errors.push(`${partId} is on the order more than once — combine the quantities.`);
    else seen.add(partId);
    const qty = Number(l && l.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 100000) errors.push(`${label}: quantity must be a whole number from 1 to 100,000.`);
    const unitPrice = Number(l && l.unitPrice);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0 || unitPrice > 100000) errors.push(`${label}: enter a unit price above zero (the PO needs a total for each line).`);
    const description = text(`${label}: description`, (l && l.description) || partId, { max: 200, required: true });
    const productId = str(l && l.productId);
    if (productId.length > 64) errors.push(`${label}: the style number is too long.`);
    return { partId, productId, description, qty, unitPrice };
  });

  return {
    errors,
    clean: {
      poNumber, orderType, currency, termsAndConditions, paymentTerms,
      rush: i.rush === true,
      allowConsolidation: i.allowConsolidation === true,
      blindShip: i.blindShip === true,
      packingListRequired: i.packingListRequired !== false, // default: yes, so receiving gets a packing list
      allowPartialShipments: i.allowPartialShipments === true,
      shipTo, freight, orderContact, shipmentComments, lines,
    },
  };
}

const contactDetails = (c) =>
  "<shar:ContactDetails>" +
  optional(s, "attentionTo", c.attentionTo) + optional(s, "companyName", c.companyName) +
  optional(s, "address1", c.address1) + optional(s, "address2", c.address2) +
  optional(s, "city", c.city) + optional(s, "region", c.region) + optional(s, "postalCode", c.postalCode) + optional(s, "country", c.country) +
  optional(s, "email", c.email) + optional(s, "phone", c.phone) +
  "</shar:ContactDetails>";

/** The exact request body. `credentialsXml` is the real login, or a placeholder for previews. */
function buildSendPoXml(c, { now = new Date(), credentialsXml } = {}) {
  const svc = SERVICES.purchaseOrder;
  const lineTotals = c.lines.map((l) => Math.round(l.qty * l.unitPrice * 100) / 100);
  const totalAmount = lineTotals.reduce((sum, x) => sum + x, 0);
  const SHIPMENT_ID = 1; // one shipment per order

  const lineItems = c.lines
    .map(
      (l, idx) =>
        "<ns:LineItem>" +
        n("lineNumber", idx + 1) +
        s("description", l.description) +
        n("lineType", "New") +
        "<shar:ToleranceDetails><shar:tolerance>ExactOnly</shar:tolerance></shar:ToleranceDetails>" +
        n("allowPartialShipments", c.allowPartialShipments) +
        s("unitPrice", price(l.unitPrice)) +
        n("lineItemTotal", money(lineTotals[idx])) +
        optional(s, "productId", l.productId) +
        "<ns:PartArray><shar:Part>" +
        s("partId", l.partId) +
        s("customerSupplied", "false") +
        s("description", l.description) +
        `<shar:Quantity><shar:uom>EA</shar:uom><shar:value>${l.qty}</shar:value></shar:Quantity>` +
        s("unitPrice", price(l.unitPrice)) +
        s("extendedPrice", money(lineTotals[idx])) +
        `<shar:ShipmentLinkArray><shar:ShipmentLink><shar:Quantity><shar:uom>EA</shar:uom><shar:value>${l.qty}</shar:value></shar:Quantity>${s("shipmentId", SHIPMENT_ID)}</shar:ShipmentLink></shar:ShipmentLinkArray>` +
        "</shar:Part></ns:PartArray>" +
        "</ns:LineItem>"
    )
    .join("");

  const oc = c.orderContact;
  const orderContactXml = oc
    ? "<ns:OrderContactArray><shar:Contact>" + optional(s, "accountName", oc.accountName) + optional(s, "accountNumber", oc.accountNumber) + s("contactType", "Order") + contactDetails(oc) + "</shar:Contact></ns:OrderContactArray>"
    : "";

  const inner =
    (credentialsXml || credentials(svc)) +
    "<ns:PO>" +
    n("orderType", c.orderType) +
    n("orderNumber", c.poNumber) +
    n("orderDate", now.toISOString().replace(/\.\d{3}Z$/, "Z")) +
    n("totalAmount", money(totalAmount)) +
    optional(n, "paymentTerms", c.paymentTerms) +
    n("rush", c.rush) +
    s("currency", c.currency) +
    orderContactXml +
    "<ns:ShipmentArray><shar:Shipment>" +
    optional(s, "comments", c.shipmentComments) +
    s("allowConsolidation", c.allowConsolidation) +
    s("blindShip", c.blindShip) +
    s("packingListRequired", c.packingListRequired) +
    `<shar:FreightDetails>${s("carrier", c.freight.carrier)}${s("service", c.freight.service)}</shar:FreightDetails>` +
    `<shar:ShipTo>${s("customerPickup", "false")}${contactDetails(c.shipTo)}${s("shipmentId", SHIPMENT_ID)}</shar:ShipTo>` +
    "</shar:Shipment></ns:ShipmentArray>" +
    `<ns:LineItemArray>${lineItems}</ns:LineItemArray>` +
    n("termsAndConditions", c.termsAndConditions) +
    "</ns:PO>";

  return { xml: requestElement(svc, "SendPORequest", inner), totalAmount: Math.round(totalAmount * 100) / 100 };
}

// Indents the request so it can be read; whitespace between elements doesn't change its meaning.
function prettyXml(xml) {
  let depth = 0;
  return xml
    .replace(/></g, ">\n<")
    .split("\n")
    .map((line) => {
      if (/^<\/[^>]+>$/.test(line)) depth -= 1;
      const out = "  ".repeat(Math.max(depth, 0)) + line;
      if (/^<[^/!?][^>]*[^/]>$/.test(line) && !/<\/[^>]+>$/.test(line)) depth += 1;
      return out;
    })
    .join("\n");
}

const PLACEHOLDER_LOGIN = "<shar:wsVersion>1.0.0</shar:wsVersion><shar:id>(your LAT login)</shar:id><shar:password>(hidden)</shar:password>";

/** Checks an order and shows exactly what would be sent. Sends NOTHING and needs no login. */
function previewPurchaseOrder(input, now = new Date()) {
  const { errors, clean } = validatePurchaseOrder(input);
  if (errors.length) throw fail(400, errors.join(" "), { details: errors });
  const { xml, totalAmount } = buildSendPoXml(clean, { now, credentialsXml: PLACEHOLDER_LOGIN });
  return {
    valid: true,
    sent: false,
    summary: {
      poNumber: clean.poNumber,
      orderType: clean.orderType,
      lines: clean.lines.length,
      pieces: clean.lines.reduce((sum, l) => sum + l.qty, 0),
      totalAmount,
      currency: clean.currency,
      shipTo: [clean.shipTo.companyName, clean.shipTo.address1, `${clean.shipTo.city}, ${clean.shipTo.region} ${clean.shipTo.postalCode}`].filter(Boolean).join(" · "),
      freight: `${clean.freight.carrier} ${clean.freight.service}`,
    },
    xml: prettyXml(xml),
  };
}

/** Read-only. Shows whether your login can use LAT's Purchase Order service, and which order types LAT accepts. */
async function getSupportedOrderTypes() {
  const svc = SERVICES.purchaseOrder;
  const reply = await post(svc, "getSupportedOrderTypes", requestElement(svc, "GetSupportedOrderTypesRequest", credentials(svc)));
  const resp = responseOf(parseBody(reply), "GetSupportedOrderTypesResponse");
  const messages = messagesOf(resp);
  const orderTypes = toArray(resp.supportedOrderTypes).map((t) => String(t));
  if (orderTypes.length === 0 && messages.some((m) => m.severity === "Error")) throw new Error(`LAT order-types error — ${describeMessages(messages)}`);
  return { orderTypes, messages };
}

// ---------- Sending (real orders) ----------

const sendEnabled = () => process.env.LAT_PO_SEND_ENABLED === "true";
const ledgerUrl = () => (process.env.PO_HISTORY_BACKEND_URL || "").replace(/\/$/, "");
const sendTimeoutMs = () => Number(process.env.LAT_PO_SEND_TIMEOUT_MS) || 60000;

// The shared record of orders sent, kept in po-history-backend. The caller's own
// login token is passed along, so the record applies the same sign-in rules.
async function ledgerCall(method, path, body, authHeader) {
  const base = ledgerUrl();
  if (!base) throw fail(503, "The order record isn't set up on this server (PO_HISTORY_BACKEND_URL), so nothing was sent.");
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: { Authorization: authHeader || "", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw fail(503, "Couldn't reach the order record, so nothing was sent.");
  }
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function sendPurchaseOrder(input, { user, authHeader, now = new Date() } = {}) {
  if (!sendEnabled()) throw fail(503, "Sending orders to LAT is switched off on the server. Set LAT_PO_SEND_ENABLED=true on the LAT service to turn it on.");
  const { errors, clean } = validatePurchaseOrder(input);
  if (errors.length) throw fail(400, errors.join(" "), { details: errors });
  if (str(input && input.confirmPoNumber) !== clean.poNumber) {
    throw fail(400, "To send a real order, type its PO number exactly to confirm.", { details: ["To send a real order, type its PO number exactly to confirm."] });
  }

  // Built BEFORE reserving, so a missing login or a bug can't leave a PO number locked for nothing.
  const { xml, totalAmount } = buildSendPoXml(clean, { now });
  const summary = { lines: clean.lines.length, pieces: clean.lines.reduce((s, l) => s + l.qty, 0), totalAmount, shipTo: clean.shipTo.companyName ? `${clean.shipTo.companyName}, ${clean.shipTo.city}` : clean.shipTo.city, freight: `${clean.freight.carrier} ${clean.freight.service}` };

  const reserved = await ledgerCall("POST", "/api/supplier-orders/reserve", { supplier: "lat", poNumber: clean.poNumber, placedBy: (user && user.email) || null, summary }, authHeader);
  if (reserved.status === 409) {
    const e = reserved.json && reserved.json.existing;
    throw fail(409, `PO ${clean.poNumber} was already ${e ? e.status : "used"}${e && e.reservedAt ? ` (${String(e.reservedAt).slice(0, 16).replace("T", " ")} UTC${e.placedBy ? ` by ${e.placedBy}` : ""})` : ""}. Nothing was sent. Use a different PO number for a new order.`, { existing: e || null });
  }
  if (reserved.status !== 200) throw fail(503, `The order record wouldn't reserve this PO (HTTP ${reserved.status}${reserved.json && reserved.json.error ? `: ${reserved.json.error}` : ""}), so nothing was sent.`);

  // From here on the PO number is reserved: whatever happens, the record is updated to say what.
  const finish = async (status, message, transactionId) => {
    try {
      const r = await ledgerCall("POST", "/api/supplier-orders/finish", { supplier: "lat", poNumber: clean.poNumber, status, message, transactionId }, authHeader);
      return r.status === 200 ? null : `The order record couldn't be updated (HTTP ${r.status}); PO ${clean.poNumber} stays locked until an admin resolves it.`;
    } catch {
      return `The order record couldn't be updated; PO ${clean.poNumber} stays locked until an admin resolves it.`;
    }
  };

  let reply;
  try {
    reply = await post(SERVICES.purchaseOrder, "sendPO", xml, sendTimeoutMs());
  } catch (err) {
    if (err.timeout) {
      const warn = await finish("unknown", err.message);
      throw fail(502, `LAT didn't answer in time, so this order MAY have been placed. PO ${clean.poNumber} is now locked. Ask LAT whether it arrived; an admin can then release it or mark it as sent.${warn ? ` ${warn}` : ""}`, { unknownOutcome: true });
    }
    const warn = await finish("failed", err.message); // couldn't connect: nothing was delivered
    throw fail(502, `${err.message}. The order was not sent.${warn ? ` ${warn}` : ""}`);
  }

  let resp;
  try {
    resp = responseOf(parseBody(reply), "SendPOResponse");
  } catch (err) {
    if (/SOAP fault/.test(err.message)) {
      const warn = await finish("failed", err.message); // LAT refused it outright
      throw fail(422, `LAT rejected the order: ${err.message}. It was not placed; you can fix it and send again.${warn ? ` ${warn}` : ""}`);
    }
    const warn = await finish("unknown", err.message); // an odd reply: can't tell
    throw fail(502, `LAT's reply wasn't understood (${err.message}), so this order MAY have been placed. PO ${clean.poNumber} is now locked. Ask LAT whether it arrived.${warn ? ` ${warn}` : ""}`, { unknownOutcome: true });
  }

  const messages = messagesOf(resp);
  const problems = messages.filter((m) => m.severity === "Error");
  if (problems.length) {
    const warn = await finish("failed", describeMessages(problems));
    throw fail(422, `LAT rejected the order — ${describeMessages(problems)}. It was not placed; you can fix it and send again.${warn ? ` ${warn}` : ""}`, { messages });
  }

  const transactionId = resp.transactionId ? String(resp.transactionId) : null;
  const warnings = transactionId ? [] : ["LAT didn't return a transaction ID. Confirm with LAT that the order arrived."];
  const ledgerWarning = await finish("sent", messages.length ? describeMessages(messages) : null, transactionId);
  return { sent: true, transactionId, messages, warnings, ...(ledgerWarning ? { ledgerWarning } : {}), placedAt: now.toISOString(), summary };
}

/** The shared record of orders sent from the app (read-only). */
async function listLatOrders(authHeader) {
  const r = await ledgerCall("GET", "/api/supplier-orders?supplier=lat", null, authHeader);
  if (r.status !== 200) throw fail(502, `Couldn't read the order record (HTTP ${r.status}).`);
  return { orders: r.json.orders || [] };
}

/** Admin only (the record enforces it): settle an order stuck as pending/unknown after checking with LAT. */
async function resolveLatOrder({ poNumber, resolution, reason }, authHeader) {
  const r = await ledgerCall("POST", "/api/supplier-orders/resolve", { supplier: "lat", poNumber, resolution, reason }, authHeader);
  if (r.status === 403) throw fail(403, "Only an admin can resolve an order.");
  if (r.status !== 200) throw fail(r.status === 400 || r.status === 404 || r.status === 409 ? r.status : 502, (r.json && r.json.error) || `The order record refused (HTTP ${r.status}).`);
  return { entry: r.json.entry };
}

module.exports = { ORDER_TYPES, validatePurchaseOrder, buildSendPoXml, previewPurchaseOrder, getSupportedOrderTypes, sendPurchaseOrder, listLatOrders, resolveLatOrder, _prettyXml: prettyXml };
