# Order Export & Import

**Closes issue #492** — Frontend order export and import with CSV/JSON support.

## Overview

The export/import feature lets users back up their WaffleFinance order history,
migrate between browsers/devices, and feed data into external tools (spreadsheets,
analytics pipelines, compliance audits).

All data stays on the client — the coordinator API is called only for export;
import is entirely local (browser `localStorage`).

---

## Supported file formats

### CSV

Schema version: `1`

Column order is fixed. Any change to the column set increments `schemaVersion`.

| Column         | Type            | Description                                      |
|----------------|-----------------|--------------------------------------------------|
| `orderId`      | string          | WaffleFinance public order ID (`wf_0x…`)         |
| `direction`    | string          | `eth-to-xlm` or `xlm-to-eth`                    |
| `sourceChain`  | string          | `ethereum` or `stellar`                          |
| `destChain`    | string          | `ethereum` or `stellar`                          |
| `sourceAmount` | decimal string  | Amount sent from the source chain                |
| `destAmount`   | decimal string  | Amount received on the destination chain         |
| `timestamp`    | unix seconds    | Order creation time                              |
| `status`       | string          | See [status values](#status-values)              |
| `beneficiary`  | string          | Wallet address that receives the destination funds |
| `refundAddress`| string          | Wallet address that receives refunds             |
| `claimedAt`    | unix seconds    | Timestamp of claim; empty if not yet claimed     |
| `refundedAt`   | unix seconds    | Timestamp of refund; empty if not refunded       |
| `schemaVersion`| string          | Always `1` in this release                       |

**Example CSV:**

```csv
orderId,direction,sourceChain,destChain,sourceAmount,destAmount,timestamp,status,beneficiary,refundAddress,claimedAt,refundedAt,schemaVersion
wf_0xabc123,eth-to-xlm,ethereum,stellar,0.5,5000.00,1700000000,completed,GABC…XYZ,0xUserAddress,1700000120,,1
wf_0xdef456,xlm-to-eth,stellar,ethereum,1000,0.09,1700001000,refunded,0xUserAddress,GABC…XYZ,,1700001500,1
```

### JSON

Schema version: `1`

The JSON format is a superset of CSV — it includes nested timestamps, the full
raw transaction object (preserving on-chain hashes), and metadata.

**Envelope structure:**

```json
{
  "schemaVersion": "1",
  "generatedAt": "2026-08-16T12:00:00.000Z",
  "totalCount": 2,
  "orders": [
    {
      "orderId": "wf_0xabc123",
      "direction": "eth-to-xlm",
      "sourceChain": "ethereum",
      "destChain": "stellar",
      "sourceAmount": "0.5",
      "destAmount": "5000.00",
      "timestamp": 1700000000,
      "status": "completed",
      "beneficiary": "GABC…XYZ",
      "refundAddress": "0xUserAddress",
      "claimedAt": 1700000120,
      "refundedAt": null,
      "schemaVersion": "1",
      "raw": {
        "id": "wf_0xabc123",
        "txHash": "0xabc…",
        "ethTxHash": "0xabc…",
        "stellarTxHash": "abc…",
        "...": "all original Transaction fields"
      }
    }
  ]
}
```

The `raw` field is included only in files exported by the frontend client. Files
produced by the coordinator API (`GET /api/orders/export`) omit `raw` but are
otherwise compatible.

### Status values

| Value        | Meaning                                   |
|--------------|-------------------------------------------|
| `pending`    | Order announced; waiting for source lock  |
| `completed`  | Both sides settled, secret revealed       |
| `confirmed`  | Destination lock confirmed on-chain       |
| `failed`     | Order failed; auto-refund may have run    |
| `refunded`   | Source funds returned to sender           |
| `expired`    | Timelock elapsed; refund available        |
| `timed_out`  | Client-side timeout (no on-chain event)   |
| `cancelled`  | Order cancelled before any lock           |

---

## How to export

1. Open the **History** tab.
2. Expand the **Export Orders** panel.
3. Choose a **Format** (CSV or JSON).
4. Set a **Date range** (last 7 days / last 30 days / all time).
5. Optionally filter by **Status**.
6. Click **Export CSV** (or **Export JSON**).

A file named `orders-YYYY-MM-DD.csv` (or `.json`) downloads automatically.

The frontend first tries the coordinator API (`GET /api/orders/export`) for an
authoritative export; if the API is unreachable it generates the file from the
orders cached in memory.

### Coordinator API endpoint

```
GET /api/orders/export
```

| Query parameter | Type    | Default | Description                               |
|-----------------|---------|---------|-------------------------------------------|
| `format`        | string  | `json`  | `csv` or `json`                           |
| `startDate`     | string  | —       | ISO date or unix seconds (lower bound)    |
| `endDate`       | string  | —       | ISO date or unix seconds (upper bound)    |
| `status`        | string  | —       | Status filter; `all` or omit for no filter|
| `orderIds`      | string  | —       | Comma-separated order IDs                 |
| `limit`         | number  | `500`   | Maximum rows (max 1000)                   |

Response: a file attachment with `Content-Disposition: attachment` and the
appropriate MIME type. The `X-Export-Schema-Version` response header carries the
schema version string.

---

## How to import

1. Open the **History** tab.
2. Expand the **Import Orders** panel.
3. Drop a file onto the drop zone, or click to browse.
   Accepted formats: `.csv`, `.json`.
4. Review the **preview table** (first 5 valid rows) and any validation warnings.
5. Click **Import N orders** to confirm.

Imported orders appear in the transaction history list. They are persisted in
`localStorage` under the key `wafflefinance_imported_orders_v1` so they survive
page refreshes.

### Validation rules

The importer validates every row before displaying the preview. Invalid rows are
**skipped** (partial import) — valid rows are always imported regardless of
errors elsewhere in the file.

| Field          | Rule                                                      |
|----------------|-----------------------------------------------------------|
| `orderId`      | Non-empty string                                          |
| `direction`    | Must be `eth-to-xlm` or `xlm-to-eth`                     |
| `sourceAmount` | Must be a valid decimal number                            |
| `destAmount`   | Must be a valid decimal number                            |
| `timestamp`    | Must be a positive integer (unix seconds)                 |
| `status`       | Must be one of the recognised status values (see above)   |

All other fields are optional; empty values are stored as `null`.

### Error messages

| Error                                       | Cause                                      |
|---------------------------------------------|--------------------------------------------|
| `Column 'orderId' is missing or empty`      | The orderId cell is blank                  |
| `Column 'direction' must be …`              | Direction is not `eth-to-xlm`/`xlm-to-eth`|
| `Column 'sourceAmount' is not a valid number` | Non-numeric sourceAmount                 |
| `Column 'timestamp' is not a valid unix timestamp` | Missing or zero timestamp           |
| `Column 'status' has unrecognised value …`  | Status not in the allowed set              |
| `Unrecognised JSON format`                  | JSON is not an array or `{orders:[…]}` envelope |
| `Could not read file`                       | The file could not be parsed at all        |

---

## Local storage

Imported orders are stored in:

```
localStorage['wafflefinance_imported_orders_v1']
```

```json
{
  "schemaVersion": "1",
  "orders": [ /* Transaction[] */ ]
}
```

- Maximum **1 000 rows** are stored (oldest are dropped if the cap is reached).
- A warning is shown in the UI when storage exceeds **5 MB**.
- Click **Clear imported orders** in the Import panel to remove all stored imports.

The `wafflefinance_transactions_v2` key (used by the live history cache) is not
affected by the import/clear operations — they are independent stores.

---

## Round-trip test

Export → import → compare:

1. Export your orders to CSV.
2. Import the same file back.
3. The importer should show **0 validation errors** and the same row count.
4. The imported orders should match the originals in the history view.

This is verified automatically by the unit test
`round-trip: client-side export → parseImportFile` in
`useOrderExportImport.test.ts`.

---

## Troubleshooting

**"No valid rows found"**  
The file does not match the WaffleFinance export schema. Check that you are
uploading a file generated by WaffleFinance (not a custom spreadsheet). Inspect
the column names in the first row — they must match the CSV schema exactly.

**"Column 'orderId' is missing" for every row**  
The CSV header row may use different column names. Re-export from WaffleFinance.

**Import button stays disabled**  
All rows failed validation. Check the error list for details.

**Download does not start**  
The coordinator API may be unreachable. The frontend falls back to client-side
generation from cached data, which should still produce a download. If nothing
happens, try refreshing the history first (Refresh button) then export again.

**Stored orders disappear after clearing browser data**  
`localStorage` is cleared when you clear browser site data. Re-import from a
previously exported file to restore your history.
