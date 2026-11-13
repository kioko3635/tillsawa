# Linked stores and the remote owner dashboard

Release prepared 29 October 2026. This release adds local-to-central reporting synchronization. It is not a database-file merge or a live connection from the owner to a shop's database.

## How records are linked

Each shop keeps its own database, users, licence, products and local branch identifiers. On the hosted central service, the owner creates one company and an entry for each store. A private pairing code maps each independent local organization/branch to its central company/store. Matching SKU strings at two stores do not merge their stock or product IDs.

The local server sends a consistent reporting snapshot approximately every minute while it is running. A sequence number and snapshot ID prevent duplicate or older uploads from increasing totals. The central service stores the latest reporting copy for that store. Sales are never replayed into a second financial ledger. The original transactions and receipts remain authoritative at the local shop.

This release uploads:

- Sales totals, payment-method totals, test-payment totals and return/refund totals, using the existing operations report calculations.
- All recorded daily gross sales/counts and authorized/paid expenses, within the payload's 20,000-day limit.
- Inventory value, on-hand quantity and low-stock count.
- Customer receivable and supplier payable totals, without individual customer contact records.
- All-time cashier sales totals and the latest 100 receipt summaries, with cashier names.
- Up to 500 active stocked items, lowest quantities first, with SKU, unit, quantity and base price. The total number of items is shown so this list cannot be mistaken for a full catalogue export.

Gross sales are not net profit or net cash. Returns and refunds are shown separately in the all-time detail. A sale made with points retains its original sale total; actual cash is reflected in the existing payment totals. Simulated/sandbox sales are explicitly flagged. The uploaded base price is not every customer-specific price-list price.

## What happens offline

If internet or the central service fails, the local server and its shared tills continue working over their local network. A saved pending snapshot is retained and retried with the same ID/sequence after a restart or connection failure. The next snapshot includes transactions and corrections since then, so individual intermediate uploads do not have to survive forever.

During a long outage, the first acknowledgement may cover an older saved snapshot; the next cycle uploads the current figures. The owner sees both capture time and receipt time. Reports are marked overdue after three minutes or while a new pairing is pending. This is an update-status indication, not proof that a store is open, closed or has internet right now.

The central overview replaces each store's snapshot rather than adding repeated uploads. Stores with different currencies receive separate totals. Revoked stores retain their historical copy but are excluded from the active-store totals.

The local server must be running for uploads. A shared till does not own a second connector/database: manage the connection on the main server, and it is shared through that server. One local database with several branches can configure a separate connection for each branch.

## Prepare the central service

The central service needs a hosted server, a public domain and HTTPS. The prepared Docker/Caddy/PostgreSQL deployment is in `deployment/multi-store`; see its README. No hosting account has been purchased, domain registered or public deployment performed. The central PostgreSQL port is not published to the internet. Shops make outbound HTTPS requests; do not forward their local POS or database ports publicly.

Create the owner's company once on the central website, and keep the remote owner login safe. Local shop accounts and remote owner accounts are separate in this version. The central workspace opens Linked stores and hides local checkout modules; business sale/stock mutations are rejected centrally. Central reporting is not a replacement for the shop's own licensing. Each local installation retains its current licence and user allowance. Branch subscription billing/limits are not added by this feature.

## Link the first store

1. Back up the local shop database, pause cashier work and stop its main server from the tray menu.
2. Install the Multi Store release on the main server or standalone shop. Reopen it with the same connection mode/address. The new migration adds Linked stores permissions to existing system Owner roles. Cashiers, waiters and procurement users do not receive them by default.
3. On the central website, sign in as owner and open **Linked stores**. Under **Add a store**, enter a unique code such as NAIROBI and its display name.
4. Choose **Create store and pairing code**. Copy the private code. An unused code expires after 24 hours. Once the first upload succeeds it becomes the store's ongoing credential.
5. At the local shop, sign in as owner and open **Linked stores → Connect this store**.
6. Select the exact local branch, enter the central website's HTTPS origin (for example `https://dashboard.your-company.co.ke`) and paste the private code.
7. Choose **Connect store**. The POS checks the central store identity and attempts an initial upload. Review Connection status and any error. Use **Sync now** to retry; local selling does not depend on that upload succeeding.
8. On the central website, verify the store name, figures and last update. Repeat with a different store entry/code for each location.

Do not post opening stock again or re-enter a store's sales at the central website. Existing stores can retain independent products and prices. Do not share pairing codes with cashiers or customers. Local connection credentials are encrypted in the database, central credentials are stored as hashes, and ordinary connection status responses omit the secrets.

## Owner: viewing stores remotely

Open the central HTTPS website on a phone or laptop and sign in. Choose All active stores or a single store. Choose Today, Last 7 days, Last 30 days or All recorded dates for the gross-sales and paid-expense overview. Dates are interpreted using each store's configured timezone.

Selecting a store also shows all-time financial details, cashier totals, uploaded stock and recent receipt summaries. These detailed sections have their own explicit period labels. Stock always reflects the most recent snapshot, not historical stock for the selected sales period. Refreshing the screen does not query the local database; it reads the central copy. The page automatically refreshes about every 30 seconds.

## Pausing, revoking and recovery

- At the local shop, **Pause uploads** stops future background attempts. It does not disable checkout or delete the central copy. An upload already in progress may finish.
- Centrally, **Revoke connection** immediately rejects further uploads for that key. Existing data is retained. This does not revoke the local POS licence or block local sales.
- **New pairing code** invalidates the old key and requires pairing the local shop again. It preserves the source organization/branch binding: create a separate store entry for a different local shop. Previous data remains labelled overdue until a fresh upload.
- If a store is already linked twice to the same central company, the central service rejects the duplicate source identity. Revoke the obsolete entry before deliberately replacing it.
- Restoring a sufficiently old local backup can reuse a sequence with different data. The service rejects this conflict instead of overwriting a newer snapshot. Verify the correct shop database and generate a new pairing code. Do not operate multiple copies of the same store database simultaneously.
- If local encryption settings were lost/changed, re-pair the connector rather than trying to view its saved credential.

Owner permissions `stores.view` and `stores.manage` can be assigned explicitly to trusted administrators. Granting `stores.view` permits company-wide linked-store reporting; it is not automatically limited to a local branch manager's branch. All central reads are tenant-scoped. A local pairing key can upload only to its assigned central store, not read the owner's dashboard or another company's records.

## Backup and operational responsibilities

Keep normal local shop backups. The central report copy cannot restore a complete shop database: it excludes full customer, supplier, product, receipt-line and payment records. Back up the central database and its hosting `.env` separately, keep copies off the server, and test restoration. Do not regenerate hosting secrets against an existing database as a routine update.

The provider licence manager remains private. Do not upload its signing key, client database, shop backups or runtime settings to the hosting source directory. The hosting source package is separately assembled from a file allow-list.

## Boundaries of this release

Implemented: independent-store reporting, durable automatic retries, duplicate/out-of-order protection, per-store credentials/revocation, tenant separation, owner web views, and stale/capture timestamps.

Not implemented here: central editing of local products/prices, centrally managed customer loyalty across stores, central staff login federation, order fulfilment between stores, or stock transfers between independent shop databases. Existing local branch transfer workflows do not automatically become cross-database transfers. Those require their own dispatch/receipt and conflict rules; this read-only reporting link does not modify local stock.

Public DNS/TLS and hosted infrastructure must be commissioned and tested after a domain/server is selected. The local acceptance test uses independent database/runtime processes on one computer; it cannot certify the client's physical network, public host, DNS or certificate setup.
