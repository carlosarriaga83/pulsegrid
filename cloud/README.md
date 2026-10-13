# Pulsegrid cloud

This folder is the deployable Node.js application. The latest Hostinger upload is the ZIP in `versions/` whose name starts with `pulsegrid-cloud-`.

The ZIP contains `server.js`, the Node package files, and `public/`. It intentionally excludes `.env`, `node_modules`, legacy copies, and previous ZIPs. Configure secrets in the Hostinger environment rather than committing them.

Firmware releases are published from the dashboard with one target per release: `servo` for COM6 or `ga25` for COM8.