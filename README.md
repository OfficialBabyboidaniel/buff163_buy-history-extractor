# BUFF163 Purchase Exporter — Chrome Extension

Export your complete BUFF163 purchase history to **CSV** and **Excel** in one click.

---

## Setup (5 minutes)

### 1. Download SheetJS (required for Excel export)

```bash
cd buff163-exporter/lib
curl -L -o xlsx.full.min.js \
  "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js"
```

Or download manually: https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js  
Save it to `lib/xlsx.full.min.js`.

### 2. Load the extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `buff163-exporter/` folder

### 3. Use it

1. Open **https://buff.163.com** and log in normally
2. Click the extension icon
3. Click **✓ Validate** — confirms your session is active
4. Click **⬇ Fetch All** — paginates through all your purchases
5. Click **↓ CSV** or **↓ Excel** to download

---

## Files

```
buff163-exporter/
├── manifest.json          # Extension manifest (MV3)
├── popup.html             # UI
├── popup.js               # All logic
├── lib/
│   └── xlsx.full.min.js  ← you download this
└── README.md
```

---

## API Endpoint Reference

| Property       | Value |
|----------------|-------|
| URL            | `GET https://buff.163.com/api/market/bill_order/list` |
| Auth           | Browser session cookie (automatic) |
| Key params     | `page_num`, `page_size` (max 30) |
| CSRF header    | `X-CSRFToken` from `csrf_token` cookie |
| Rate limit     | ~600ms between requests |
| Response shape | `{ code: "OK", data: { items: [], total_count: N } }` |

---

## Exported Fields

`Order ID` · `Date` · `Item Name` · `Short Name` · `Game` · `Quality` · `Exterior` · `Float Value` · `Price (¥)` · `Currency` · `Quantity` · `Buyer Fee (¥)` · `Total Cost (¥)` · `Seller ID` · `Type` · `Item URL` · `Goods ID` · `Asset ID`

Excel output has two sheets:
- **Orders** — one row per purchase
- **Summary** — totals, spend, monthly/yearly breakdown, top 20 items

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "Not logged in" | Open buff.163.com in the same browser and sign in |
| Excel button does nothing | Make sure `lib/xlsx.full.min.js` is present |
| Stops mid-way | Click Fetch All again — it resumes from checkpoint |
| Missing item names | BUFF's API sometimes nests them differently; Order ID is always present |

---

## Legal

This extension only reads data from your own authenticated session.  
It does not bypass authentication or access other users' data.  
Respect BUFF163's Terms of Service.
