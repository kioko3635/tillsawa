# Central owner dashboard — hosting setup

This is the hosted reporting service, not the Windows till installer. It uses the same API/web application in `MULTI_STORE_HUB=true` mode. Stores keep trading locally and push reporting snapshots over HTTPS.

For selling and managing stock directly on a hosted instance, use the separate [Cloud POS deployment](CLOUD-POS.md).

## Requirements

- A Linux server with Docker Engine and the Compose plugin, with sufficient storage for the expected store reports and backups.
- A domain/subdomain controlled by your company. Point its A/AAAA records at this server.
- Public inbound TCP 80 and 443 to the Caddy gateway. Do not publish PostgreSQL or the API container port directly. Administrative server access should follow your host's own management setup.
- The complete prepared hosting source folder, including root package lock, source workspaces, database migrations and this deployment directory. No provider private key or shop data is required.

No public server, domain or TLS certificate has been provisioned by preparing these files.

## First deployment

From the hosting source root, generate secrets once (replace the example domain):

```sh
node deployment/multi-store/prepare-hosting.mjs dashboard.your-company.co.ke
cd deployment/multi-store
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 hub gateway
```

If Node is not installed on the host, use a temporary Node container from the source root:

```sh
docker run --rm -v "$PWD:/work" -w /work node:22-bookworm-slim node deployment/multi-store/prepare-hosting.mjs dashboard.your-company.co.ke
```

The generator writes private random, distinct secrets to `deployment/multi-store/.env` and refuses to overwrite an existing file. Keep this file protected and back it up separately. Passwords are hexadecimal so the supplied connection URLs do not need additional URL escaping. Do not share or commit the generated `.env`.

Database initialization creates separate application and system identities. The API receives neither the PostgreSQL bootstrap administrator password nor a published database port. Migrations run through the dedicated system identity before the API starts. Compose waits for health checks before starting dependent services.

Caddy obtains and renews a public certificate when DNS and public network access are correctly configured. Open the HTTPS website, create the central company/owner account, then use Linked stores to create each store and its pairing code. See `docs/multi-store-owner-dashboard.md` in the source package for local setup.

The central service does not post shop sales, accept payments or manage shop stock. Its business mutations are blocked. Local licences remain local; central subscription billing is not included. The existing token-based password-reset screen still requires an operational reset-token delivery/support process; this deployment does not add automatic email/SMS recovery.

## Backups

From this deployment directory, write the binary dump inside the container and copy it out. This avoids corrupting a binary dump through shell text redirection on Windows:

```sh
docker compose exec -T database pg_dump -U pos_bootstrap -d kenya_pos_hub -Fc -f /tmp/owner-dashboard.dump
docker compose cp database:/tmp/owner-dashboard.dump ./owner-dashboard.dump
```

Copy that dump to protected storage away from the server, with a timestamped name. Back up `.env` and retain the database/certificate volumes. Verify restoration into a separate test deployment before relying on the procedure. Local shop backups remain necessary because central snapshots are not complete copies of shop databases.

## Updating

Take a central backup, preserve `.env` and the volumes, replace the hosting source with the new release and run `docker compose up -d --build`. Do not use volume deletion as an update step. Check health and a store upload afterwards. Shops retain pending reports and continue local checkout if the hosted service is temporarily unavailable.

Database initialization scripts run only for a new PostgreSQL data directory. Changing credentials in `.env` does not automatically change passwords in an existing database; use a planned credential rotation instead of rerunning the generator.

## Troubleshooting

- Certificate not issued: check domain DNS, routing and gateway ports. Do not disable TLS verification in the stores.
- Website works but a shop cannot pair: use only the HTTPS origin, no `/login` path. Generate a fresh unused code and check its expiry.
- Store marked overdue: check the local POS is running and inspect its Linked stores connection status. Its local checkout should continue.
- Repeated/conflicting sequence: verify the correct database/backup and re-pair using a new code. Do not run cloned copies of one store.
- Persistent 401 after a code rotation: pair the local connector with the replacement code.

Official deployment references: [Caddy HTTPS requirements](https://caddyserver.com/docs/automatic-https), [Docker Compose health-dependent startup](https://docs.docker.com/compose/how-tos/startup-order/).
