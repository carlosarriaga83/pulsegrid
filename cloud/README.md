# Pulsegrid cloud

This folder is the deployable Node.js application. The latest Hostinger upload is the ZIP in `versions/` whose name starts with `pulsegrid-cloud-`.

The ZIP contains `server.js`, the Node package files, and `public/`. It intentionally excludes `.env`, `node_modules`, legacy copies, and previous ZIPs. Configure secrets in the Hostinger environment rather than committing them.

Device provisioning uses `PULSEGRID_BOOTSTRAP_API_KEY` (default `pg_bootstrap_v1`) only for `/api/device-presence` and `/api/device-bootstrap`. It cannot submit telemetry or fetch normal commands. Set the same value in Hostinger if you rotate the bootstrap key, then publish firmware with the matching value.

Firmware releases are published from the dashboard with one target per release: `servo` for COM6 or `ga25` for COM8.