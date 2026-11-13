# TillSawa cloud deployment

You can run checkout and the remote owner dashboard on one Linux VPS with Docker Engine and Compose. The provider subscription manager runs inside cloud checkout at **/subscription-management/**. The Windows POS and Windows Licence Manager still work separately.

## Deploy on one server

1. Create two DNS records on your TillSawa domain, for example **pos.example.co.ke** and **dashboard.example.co.ke**, both pointing to the VPS. Allow TCP 80 and 443 to Caddy. Do not expose the API or database ports.
2. Upload this source folder. From its root, run the following, using the real domain names:

```sh
node deployment/multi-store/prepare-hosting.mjs dashboard.example.co.ke
node deployment/multi-store/prepare-hosting.mjs pos.example.co.ke --cloud
docker network inspect tillsawa_edge >/dev/null 2>&1 || docker network create tillsawa_edge
cd deployment/multi-store
```

3. In the reporting **.env**, add **POS_CHECKOUT_DOMAIN=pos.example.co.ke**. Keep **.env** and **.env.cloud** private. The cloud file contains the setup key, provider password and stable licence identity.
4. Start both projects. Checkout and reporting use separate databases. The reporting project runs the one HTTPS gateway for both domains.

```sh
docker compose -p tillsawa-cloud-pos --env-file .env.cloud -f compose.yaml -f compose.cloud.yaml -f compose.suite-cloud.yaml up -d --build
docker compose -p tillsawa-owner-reporting --env-file .env -f compose.yaml -f compose.suite-hub.yaml up -d --build
```

5. Check both HTTPS websites and their **/api/v1/health/ready** responses. Create the reporting owner on the dashboard website. Create cloud shops on the checkout website with the private **POS_CLOUD_SETUP_KEY**. Clear that key when onboarding is closed and recreate the checkout service with the same Compose command. To onboard more shops later, set a new private setup key and repeat.
6. If you already have a deployed project, keep its Compose project name and database volumes. Back up both databases and environment files first. For an existing **.env.cloud**, keep all existing values and add **POS_INSTALLATION_ID** (UUID), **POS_MACHINE_ID** (64 lowercase hex characters), and **POS_MANAGEMENT_PASSWORD** (a different random 64-character lowercase hex string) before first enabling licensing. Generate each once; do not rotate installation identity, machine ID or the existing access-token secret during an ordinary upgrade. Changing them invalidates installed licence state.

A basic shared hosting plan without Docker or persistent Node/PostgreSQL cannot run this Compose bundle. Confirm hosting access and the full DNS names before attempting public deployment. If using two separate VPSs, use **compose.yaml** on reporting and **compose.yaml + compose.cloud.yaml** on checkout, without the shared-gateway overlays.

## Manage cloud subscriptions

1. Open **https://pos.example.co.ke/subscription-management/**. Sign in as **operator** with the generated **POS_MANAGEMENT_PASSWORD**. This credential is for the provider team only.
2. Find the shop, choose **Download request**, then import that request into the existing private Windows Licence Manager. Issue the licence with your existing signing key. Keep that key and client register off the VPS.
3. In the hosted manager choose **Install licence**, paste the signed **.poslicense** contents and submit. A licence issued for a different shop is rejected. An unlicensed or expired shop can sign in and view records, but cannot post new sales or normal operational writes. A licence still in its signed grace period can continue trading. Renew by installing the new signed file.
4. **Active licences** are current licences. **Recently active licensed shops** are licensed cloud shops whose nonexpired authenticated session was seen in the last 15 minutes. This is recent server activity, not a count of connected devices. Offline Windows licences do not appear in this total, and billing or payment collection for subscriptions is not automated.

## Link stores to the owner dashboard

Create a store and pairing code in the reporting owner's **Linked stores** page. On each Windows main server or cloud checkout shop, use **Linked stores → Connect this store** with the dashboard's HTTPS address and that store's code. Each shop sends reports outbound. The owner's dashboard does not connect directly to any shop database. During a connection outage local checkout continues on its LAN, and the dashboard shows the last received snapshot. Keep shop backups independently.

Pesapal and Daraja retain their existing configuration and test/live boundaries. See the payment setup guide before enabling payments on the hosted checkout.
