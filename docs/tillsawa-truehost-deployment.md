# TillSawa on Truehost

Start in your existing Truehost panel. For cPanel, look for **Git Version Control**, **Setup Node.js App** (or **Application Manager**), and **PostgreSQL Databases**. The feature names may differ. Truehost advertises Node.js and Git for shared hosting, but PostgreSQL, the Node version, and persistent background jobs must be confirmed for your actual plan.

Send Truehost support this:

> Please confirm whether my existing tillsawa.com plan supports two Node.js 22 applications on pos.tillsawa.com and dashboard.tillsawa.com, HTTPS on both, two PostgreSQL databases with app and migration roles (including SET ROLE and schema migrations), and a Node process that stays running for background reporting. Can you clone a private GitHub repository using a read-only deploy key and tell me the startup file and port conventions for my panel? If PostgreSQL is not offered locally, are outbound connections to managed PostgreSQL over TLS allowed?

Once confirmed:

1. Give Truehost the private GitHub repo URL and authorize its read-only access. Use the prepared cloud source, without the local shop data or private signing key. Keep the clone and secrets outside public_html.
2. Build the source from the repository root: npm ci; npm run build --workspace @pos/contracts; npm run build --workspace @pos/api; npm run build --workspace @pos/web.
3. Configure the two apps and separate PostgreSQL databases using **docs/tillsawa-existing-cloud-host.md**. For a panel requiring a CommonJS startup file, use the supplied **cpanel-start.cjs** in the repository root. Supply a numeric API_PORT if the host does not provide PORT. Ask support to verify reverse proxy handling and the HTTPS protocol passed to the application before using the provider manager.
4. Map pos.tillsawa.com to checkout and subscription management; map dashboard.tillsawa.com to owner reporting. Use the DNS targets Truehost gives you. After HTTPS is active, check **/api/v1/health/ready** on both sites, then test licence activation and store pairing before onboarding real shops.

No Docker install or Linux administration is needed on your PC. If the plan has only MySQL and cannot connect to managed PostgreSQL, this package cannot run on that plan as-is.

