/**
 * po.js
 * -----
 * LAT Apparel Purchase Order 1.0.0 (PromoStandards). Layouts, element order,
 * limits, and allowed values follow LAT's own XSD files (SendPORequest,
 * SharedObjectsPO, ...); the builder below is validated against them in tests.
 *
 * THIS STAGE CANNOT SEND AN ORDER. It offers two things only:
 *   - getSupportedOrderTypes: a read-only call that shows whether your login
 *     can use the Purchase Order service and which order types LAT accepts.
 *   - previewPurchaseOrder: checks an order and builds the exact request that
 *     would be sent — with the login shown as a placeholder — and sends nothing.
 *
 * Why so careful: LAT has no test endpoint, so a sendPO is always a real
 * order, and the PO service has no cancel or lookup. Sending is added later,
 * together with a record of orders already sent (to stop duplicates).
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

module.exports = { ORDER_TYPES, validatePurchaseOrder, buildSendPoXml, previewPurchaseOrder, getSupportedOrderTypes, _prettyXml: prettyXml };
