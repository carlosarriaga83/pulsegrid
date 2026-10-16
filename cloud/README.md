# Pulsegrid cloud

This folder is the deployable Node.js application. The latest Hostinger upload is the ZIP in `versions/` whose name starts with `pulsegrid-cloud-`.

The ZIP contains `server.js`, the Node package files, and `public/`. It intentionally excludes `.env`, `node_modules`, legacy copies, and previous ZIPs. Configure secrets in the Hostinger environment rather than committing them.

Each firmware device authenticates telemetry, command polling/ACKs, and OTA with a 44-character hexadecimal `DEVICE_CODE` generated deterministically from its MAC. The first 12 characters are the normalized MAC; the remaining 32 are the first half of SHA-256 over `pulsegrid-device-code-v1:` plus that MAC. The burner can calculate the same code from a manually entered MAC. Cloud derives the Device ID and stores only the code's SHA-256 hash. **This deterministic code is not a secret:** anyone who knows the MAC can calculate it and impersonate the device. Device endpoints require HTTPS, but HTTPS does not compensate for a guessable device credential. Existing devices using the former random code must be updated in cloud and reflashed with the deterministic code. The captive portal is limited to Wi-Fi credentials. User API keys remain available for external telemetry and firmware integrations but are not used by the ESP32 firmware.

Firmware releases are published from the dashboard with one target per release: `servo` for COM6 or `ga25` for COM8.