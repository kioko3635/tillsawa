# TillSawa cloud deployment for Truehost

Clone the repository into a private application directory, outside public_html. Deploy from the repository root, where package.json and package-lock.json are located.

1. Select Node.js 22 and run npm ci --include=dev from the repository root. If cPanel does not offer a build step, run this in the app's Node environment in Terminal or ask Truehost support to run it.
2. Run npm run build. This creates packages/contracts/dist, apps/api/dist, and apps/web/dist. Those generated files and node_modules are intentionally not checked into Git. Build before starting either app.
3. Set cpanel-start.cjs as the Node.js startup file, or run npm start if the host asks for a start command. Configure each app's own environment and PostgreSQL database before starting.
4. Follow [Truehost setup](docs/tillsawa-truehost-deployment.md) and [environment settings](docs/tillsawa-existing-cloud-host.md). Do not upload an .env or signing key to GitHub. The public verification key is already tracked.

Use a Git clone, or extract the complete repository archive. Browser file previews are not the deployed app. If a command fails, share the first error, the command and the exact missing path, with any secrets removed.
