# LAT Backend

Proxies PO Control's requests to LAT Apparel's PromoStandards SOAP services, so the LAT login stays out of the browser. Same role as `stanley-stella-backend` and `fidelitone-backend`.

| Route | LAT service | What it returns |
|---|---|---|
| `GET /api/lat/sellable` | Product Data 2.0.0 `getProductSellable` | Styles/parts LAT will sell. `?productId=` / `?partId=` to narrow. |
| `GET /api/lat/inventory?productId=` | Inventory 2.0.0 `getInventoryLevels` | Per part: stock, per-warehouse stock, future arrivals, lead time. Optional `partIds`, `sizes`, `colors` (comma-separated). |
| `GET /api/lat/pricing?productId=&fobId=&priceType=` | Pricing & Config 1.0.0 `getConfigurationAndPricing` | Quantity-break prices for blanks. `priceType` is `Customer`, `List`, or `Net`. |
| `GET /api/lat/fob-points?productId=` | Pricing & Config `getFobPoints` | Valid `fobId`s. **Unverified**, see below. |

Add `&raw=1` to any route to get LAT's reply XML instead of the normalized form (for debugging). Raw output never includes the request, so never the password.

### Purchase orders

| Route | What it does |
|---|---|
| `GET /api/lat/po/order-types` | Read-only. Shows whether your login can use LAT's Purchase Order service and which order types LAT accepts. |
| `POST /api/lat/po/preview` | Checks an order against LAT's limits and returns the exact request that would be sent, with the login as a placeholder. Sends nothing and needs no login. |
| `POST /api/lat/po/send` | **Places a real order.** Off unless `LAT_PO_SEND_ENABLED=true`. Needs the order plus `confirmPoNumber` (the PO number typed again). |
| `GET /api/lat/po/orders` | The shared record of orders sent from the app. |
| `POST /api/lat/po/resolve` | Admins only: settle an order stuck as pending/unknown after checking with LAT (`released` or `sent`, with a reason). |

**LAT has no test endpoint, so every send is a real order,** and its PO service has no cancel or lookup. The safeguards are enforced here on the server:
- Sending is **off by default**.
- The PO number must be **typed to confirm** (checked here, not just on screen).
- The order is checked against LAT's limits and its request is built **before** anything is reserved.
- The PO number is **reserved in the shared record first**; if the record can't be reached, nothing is sent. A PO already pending, sent, or unknown is refused (409). Reserving is atomic: of 20 simultaneous sends of one PO, one reaches LAT.
- If LAT doesn't answer, or replies with something unreadable, the order **may exist**: the PO is locked as `unknown` until an admin resolves it. A clean refusal (LAT error message or SOAP fault) is recorded `failed` and can be fixed and retried.
- LAT's reply to `sendPO` is only a transaction ID; it does not confirm acceptance. Order Status (a separate LAT service) is what confirms.

The request builder is validated against LAT's own XSD files in tests, including each length limit at and one past its boundary.

All routes except `/api/health` need a PO Control login token.

## Environment variables (set on Render)

- `LAT_PS_ID` — your PromoStandards ID from LAT
- `LAT_PS_PASSWORD` — your PromoStandards password
- `SESSION_SECRET` — must match `po-history-backend` exactly
- `PO_HISTORY_BACKEND_URL` — the address of `po-history-backend`, where the record of orders sent is kept (needed for sending)
- `LAT_PO_SEND_ENABLED` — set to `true` to allow real orders; leave unset to keep sending off
- `ALLOWED_ORIGINS` — optional, comma-separated
- `LAT_PS_BASE_URL` — optional, defaults to `https://promostandards.latapparel.com/live`
- `LAT_PO_SEND_TIMEOUT_MS` — optional, how long to wait for LAT's reply to an order (default 60000)

## How it was verified

Request layouts follow LAT's own XSD files (element names, order, namespaces). Every request this service builds was validated against those schemas, and negative tests confirmed the validator rejects missing/misordered/invalid fields. Responses were parsed against schema-valid sample replies. LAT has no test endpoints, so the **first real call is the first contact with LAT's actual data** — expect small surprises in values (ID formats, location names), not in structure.

## Learned from LAT's real replies

- LAT wraps replies in `<ResponseDataset>` instead of the response element its schema names (e.g. `GetProductSellableResponse`). The client accepts either.
- Failures come back as `ServiceMessage` entries (e.g. code 105, "Authentication Credentials failed"), and are reported with LAT's own code and wording.

## Known gaps

- `getFobPoints`: LAT's schema for it wasn't provided, so its request follows the PromoStandards standard, unchecked. If it errors, send me `GetFobPointsRequest.xsd` / `GetFobPointsResponse.xsd`, or ask LAT which `fobId` to use.
- The two ISO lookup schemas (country and currency codes) weren't provided; checks used stand-ins that validate structure but not code values.
- LAT's real replies to `sendPO` haven't been seen yet; the reply handling follows LAT's schema. Expect the first live order to be the first contact.

## Local run

```bash
npm install
cp .env.example .env   # fill in values
npm start              # http://localhost:3006
```
