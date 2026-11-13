# TillSawa — Windows x64 test edition

This is a local application with its own PostgreSQL database and bundled Node.js runtime. It supports cash, customer credit, manually verified M-Pesa/card payments, simulated payments and an optional Daraja sandbox adapter. Sandbox and simulated payments move no money. This edition is for functional testing before a client rollout.

## Install on another computer

1. Use Windows 10/11 x64. Copy **TillSawa Setup.exe** to the computer and double-click it. Click **Install TillSawa**. The installer contains the application, Node.js, PostgreSQL and offline Microsoft prerequisites.
2. Click **Open TillSawa**, or use the **TillSawa** desktop / Start menu shortcut created by setup.
3. The native **TillSawa.exe** opens its own POS window with a KP icon. It starts the backend and local database in the background, displays startup progress and reports errors visibly. No terminal window or separate browser launch is needed.
4. Create the owner account and shop, choose its business type, select products, set prices and opening stock, create/open a till, and test sales. There are no preloaded customer accounts or passwords.

Data and randomly generated local credentials are stored in **%LOCALAPPDATA%\KenyaPOS-Test**, with the current Windows user's profile permissions. Setup installs program files in a separate versioned Application folder within that directory. The database accepts loopback connections only. Node and PostgreSQL do not need separate installation. Internet is unnecessary for ordinary checkout and catalogue images. Microsoft WebView2 is installed from the bundled offline installer if missing.

Close the native POS window to shut down its backend and database. Reopening the desktop icon starts them again. Opening the icon twice brings the existing window forward. Reinstalling preserves the database and shop settings. Do not delete the data directory when replacing program files.

For troubleshooting, use **TillSawa > View startup log**. The log is stored at **%LOCALAPPDATA%\KenyaPOS-Test\desktop-startup.log**. A failed startup displays an error and a retry button. The older CMD files are diagnostic tools; normal use is through the desktop EXE.

## Subscription activation

The licensed edition requires activation after shop setup (including existing shops upgrading to this edition). Open **Subscription → Download activation request**, send the request to your provider, then use **Import licence file** to import their reply. Valid licences work offline, including a configured grace period. Expiry preserves records, reports and backups but blocks new business writes until renewed. Read `SUBSCRIPTION-GUIDE.md` for the complete flow. Provider signing keys and the provider Licence Manager are never included in this client installer.

## Payments

Cash and customer credit follow the existing checkout flow. For M-Pesa/card, prepare a payment attempt, verify the exact amount and transaction reference against the merchant account or card terminal, confirm it, then complete the sale. This is manual reconciliation, not an automatic live provider integration. Never enter card numbers, PINs or CVVs.

The simulator offers paid, failed and cancelled outcomes. Daraja sandbox is enabled only with locally configured sandbox credentials. Both are visibly labelled as tests and included in test reports; do not use this database for real shop accounting. A confirmed payment can be attached to only one sale. Changing the cart after requesting payment blocks completion. Keep that cart until checkout succeeds; reconcile unattached attempts in payment history if the window is closed or checkout cannot finish. Automatic electronic refunds and voids are unavailable; do not substitute a drawer cash refund for provider reconciliation.

## Optional Daraja sandbox setup

Create **%LOCALAPPDATA%\KenyaPOS-Test\daraja-sandbox.env** with your sandbox values:

```dotenv
DARAJA_CONSUMER_KEY=your_sandbox_consumer_key
DARAJA_CONSUMER_SECRET=your_sandbox_consumer_secret
DARAJA_PASSKEY=your_sandbox_passkey
DARAJA_SHORTCODE=174379
DARAJA_CALLBACK_URL=https://your-own-https-endpoint.example/mpesa-callback
```

Use an actual HTTPS callback endpoint you control and the shortcode assigned to your sandbox configuration. Restart the application after editing. Do not send credentials in chat or distribute this file. Daraja requires Internet and a publicly reachable HTTPS callback; localhost alone cannot receive provider callbacks. This POS confirms status by an authenticated sandbox query, not by accepting an unverified callback or the initial request acknowledgment. No public relay or live-money adapter is included. The adapter has automated mocked-provider tests; actual end-to-end sandbox testing requires your credentials and callback.

Official setup: https://developer.safaricom.co.ke/apis/MpesaExpressSimulate

## Backup and testing

Run **TillSawa > Back up shop database** regularly. Custom PostgreSQL dump files and SHA-256 checksums are stored in the data directory under backups. Copy backups and settings.json to secure external storage. Backups contain shop/customer data; do not share them publicly. Recovery should be rehearsed with a technician before client rollout. The application also takes a backup on startup.

Test owner/cashier permissions, till opening/closing, cash change, stock reductions, customer credit, manual references, duplicate references, simulator failure/cancellation, receipts, reports, restart persistence and backup. Test printing on the actual receipt printer. Catalogue images and business templates still require product-match and commercial image-permission review; see CATALOGUE-NOTES.md. This package does not certify eTIMS compliance or connect live payment terminals.

Bundled runtimes: official Node.js 22.23.4, PostgreSQL 16.15 EDB Windows binaries and signed Microsoft Visual C++ x64 redistributable. Their licenses are included beside their runtime files. No developer database, existing .env, sandbox credentials or real customer records are included.
