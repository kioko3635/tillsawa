# TillSawa deployment choices

| Mode | Checkout | Source of truth |
| --- | --- | --- |
| Windows standalone | Shop computer; internet is optional for local sales | Local PostgreSQL |
| Windows shared server and tills | Tills use the shop's main server over the LAN | Main shop server PostgreSQL |
| Cloud POS | Browser over HTTPS; checkout pauses when the connection is lost | Hosted PostgreSQL |
| Cloud reporting hub | Reporting only; shops sell in their local installations | Store data stays local; the hub holds reporting snapshots |

Cloud POS and local POS are alternative ways to run a shop. Running both does not synchronize products, stock, users or sales. Use the separate reporting hub if local shops need remote reporting. Plan and validate a data migration before moving an existing shop between deployments.

## Set up a cloud POS instance

Use a Linux server with Docker and Compose, a domain pointed at it, and inbound TCP ports 80 and 443. Run from the source root:

```sh
node deployment/multi-store/prepare-hosting.mjs pos.example.co.ke --cloud
cd deployment/multi-store
docker compose -p tillsawa-cloud-pos --env-file .env.cloud -f compose.yaml -f compose.cloud.yaml up -d --build
```

Caddy handles HTTPS. PostgreSQL and the API are on the container network. Use a separate host or gateway configuration if your reporting hub already binds these ports; keep distinct Compose projects and volumes.

Open the HTTPS URL. Register the business using the private setup key in .env.cloud. After onboarding, clear POS_CLOUD_SETUP_KEY and run the same Compose command again (the server denies setup without the key). Keep the environment file private and back up the database off the server. This deployment does not configure automated backups, billing, live payment integrations or Windows-only cash drawer hardware for browsers. Check access permissions and restore a backup in staging before going live.

## Local installations

Use the TillSawa Windows setup and select Standalone or Main shared server. On additional local tills select Shared till and connect to the main server. Back up an existing shop before updating. The same workspace design applies; local printer and drawer setup remains in the installed Windows app.

No public cloud instance, DNS or TLS certificate is provisioned by these source changes.
