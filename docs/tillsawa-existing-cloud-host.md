# TillSawa setup for your existing cloud host

Use the existing cloud source package. Ask the provider whether your plan can run two persistent Node.js 22 applications, provide PostgreSQL with separate databases and migration privileges, and serve two HTTPS subdomains. If the panel only accepts static files or PHP, uploading the package alone will not run TillSawa.

| App | HTTPS address | Runtime |
| --- | --- | --- |
| Checkout and subscription management | https://pos.tillsawa.com | POS_CLOUD=true, MULTI_STORE_HUB=false |
| Owner dashboard | https://dashboard.tillsawa.com | POS_CLOUD=false, MULTI_STORE_HUB=true |

Build each app from the source root with npm ci, then npm run build --workspace @pos/contracts, npm run build --workspace @pos/api, and npm run build --workspace @pos/web. Use node deployment/multi-store/hub-entry.mjs as the start command from that root. Keep apps/api/data/license-public-key.pem in the deployed source. The existing deployment scripts document the required PostgreSQL roles and grants; arrange those with the host before startup.

For both apps set NODE_ENV=production, SERVE_WEB=true, COOKIE_SECURE=true, and CORS_ORIGIN to that app's exact HTTPS address. Set API_HOST and API_PORT to the host's assigned listener (the app reads API_PORT, so map the panel-assigned port to it). If the host terminates HTTPS, configure TRUST_PROXY to match the supported single trusted proxy setup; do not expose the Node listener directly in that configuration. Give each app its own DATABASE_URL, DATABASE_SYSTEM_URL, ACCESS_TOKEN_SECRET, REFRESH_TOKEN_PEPPER and CSRF_SECRET.

For checkout also set POS_LICENSE_REQUIRED=true, POS_INSTALLATION_ID (stable UUID), POS_MACHINE_ID (stable random 64 lowercase hex characters), POS_MANAGEMENT_PASSWORD (a separate random 64 lowercase hex characters), and POS_CLOUD_SETUP_KEY (random 64 lowercase hex characters for onboarding). Keep these values private and preserve licence identity and access-token secret across updates. For reporting set POS_LICENSE_REQUIRED=false. Subscription management is at /subscription-management/ on the POS site; the Windows signing key stays offline.

Use the exact DNS targets supplied by the hosting panel. Verify each HTTPS /api/v1/health/ready endpoint, then test shop activation and pair a store through Linked stores before client rollout. No local Windows installation needs to change for deployment.
