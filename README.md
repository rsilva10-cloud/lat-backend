# LAT Backend

Proxies PO Control's requests to LAT Apparel's PromoStandards SOAP services, so the LAT login stays out of the browser. Same role as `stanley-stella-backend` and `fidelitone-backend`.

| Route | LAT service | What it returns |
|---|---|---|
| `GET /api/lat/sellable` | Product Data 2.0.0 `getProductSellable` | Styles/parts LAT will sell. `?productId=` / `?partId=` to narrow. |
| `GET /api/lat/inventory?productId=` | Inventory 2.0.0 `getInventoryLevels` | Per part: stock, per-warehouse stock, future arrivals, lead time. Optional `partIds`, `sizes`, `colors` (comma-separated). |
| `GET /api/lat/pricing?productId=&fobId=&priceType=` | Pricing & Config 1.0.0 `getConfigurationAndPricing` | Quantity-break prices for blanks. `priceType` is `Customer`, `List`, or `Net`. |
| `GET /api/lat/fob-points?productId=` | Pricing & Config `getFobPoints` | Valid `fobId`s. **Unverified**, see below. |

Add `&raw=1` to any route to get LAT's reply XML instead of the normalized form (for debugging). Raw output never includes the request, so never the password.

All routes except `/api/health` need a PO Control login token.

## Environment variables (set on Render)

- `LAT_PS_ID` — your PromoStandards ID from LAT
- `LAT_PS_PASSWORD` — your PromoStandards password
- `SESSION_SECRET` — must match `po-history-backend` exactly
- `ALLOWED_ORIGINS` — optional, comma-separated
- `LAT_PS_BASE_URL` — optional, defaults to `https://promostandards.latapparel.com/live`

## How it was verified

Request layouts follow LAT's own XSD files (element names, order, namespaces). Every request this service builds was validated against those schemas, and negative tests confirmed the validator rejects missing/misordered/invalid fields. Responses were parsed against schema-valid sample replies. LAT has no test endpoints, so the **first real call is the first contact with LAT's actual data** — expect small surprises in values (ID formats, location names), not in structure.

## Known gaps

- `getFobPoints`: LAT's schema for it wasn't provided, so its request follows the PromoStandards standard, unchecked. If it errors, send me `GetFobPointsRequest.xsd` / `GetFobPointsResponse.xsd`, or ask LAT which `fobId` to use.
- The two ISO lookup schemas (country and currency codes) weren't provided; checks used stand-ins that validate structure but not code values.
- Purchase Order (`sendPO`) is not built yet. It places real orders and LAT has no test environment, so it needs a confirmation step first.

## Local run

```bash
npm install
# create a .env file with the variables listed above
npm start              # http://localhost:3006
```
