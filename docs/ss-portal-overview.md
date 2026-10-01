---
name: ss-portal-overview
description: "What SS Enterprise online portal is, its stack, and how to work with it locally"
metadata:
  node_type: memory
  type: project
  originSessionId: 3279acd2-59dd-4eaa-ba63-08abbd79f0db
  modified: 2026-09-29T08:32:26.634Z
---

"SS Enterprise online portal" (D:\SS Enterprise online portal) is a store-management web app for Singur Bigmart, owned/operated by the user (Subhasis Samanta, ssamanta@calance.com).

**Stack**: ASP.NET Core 9 minimal API (`api/`, no separate frontend project) serving a vanilla-JS SPA from `api/wwwroot/` (no build step — `index.html` loads `js/data.js` + `js/app.js` directly, or `js/mockdata.js` + `js/data.mock.js` under `?mock=1` demo mode). Backend uses Dapper over SQL Server. A git repo exists now (branch master; user commits themselves, e.g. "fine tuning") — never commit unless asked.

**Database**: SQL Server at `bigmartsingur.in`, database `bigmartsingur_in_dev`. Connection string lives in `dotnet user-secrets` under `ConnectionStrings:bigmartconn` (run `dotnet user-secrets list` from `api/` to retrieve it for direct `sqlcmd` diagnosis — don't hardcode it anywhere). Real production data, not synthetic — treat writes/schema assumptions carefully; always verify a table's actual columns via `INFORMATION_SCHEMA.COLUMNS` before assuming a field exists (this DB has surprised us more than once, e.g. no separate cheque-clearing-date column, no expense-date column).

**Dev workflow quirks**:
- `api/wwwroot/*` static files (js/css/html) are served directly — edits apply immediately, no rebuild needed.
- C# endpoint changes DO need a rebuild + **restart of the running `api.exe` process** to take effect. `dotnet build` frequently fails with a file-lock error (`MSB3027`/`MSB3021`) because the dev server is already running — that's not a compile error; check for actual `error CS` lines to know if the code is really broken, then have the user restart the process to pick up backend changes.
- `index.html` has a single cache-busting constant, `ASSET_V` (declared once near the top, used for both the CSS `<link>` via `document.write` and every JS `<script>` load) — **bump it whenever any wwwroot js/css file changes**, or browsers can keep serving stale assets and throw confusing errors (e.g. `undefined.toFixed`) after a field is renamed/removed server-side. (Earlier in the project the stylesheet had its own separate version string that drifted out of sync for several rounds — now consolidated to one constant, don't reintroduce a second one.)

**Nav trimming (partially reversed 2026-09-29)**: sidebar originally only showed Dashboard, Vendor payments, Cheque details, Expenses (Sales, Sales by month, Monthly profit, Customer credit, Product report, Product sync were hidden). On 2026-09-29 the user asked to re-enable Sales and Sales by month, so the nav now also shows those two — current order: Dashboard, Sales, Sales by month, Vendor payments, Cheque details, Expenses. A **Reports** item also appears, but only for the `subhasis` login (see [[ss-portal-status]]). Monthly profit, Customer credit, Product report, Product sync remain unlinked (routes still work by hash, just not in nav) — don't add those back without being asked.

See [[ss-portal-status]] for what's been built and where things stood when the user said "we will begin later".
