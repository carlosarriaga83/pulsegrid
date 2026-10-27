# Pulsegrid cloud

This folder is the deployable Node.js application. The latest Hostinger upload is the ZIP in `versions/` whose name starts with `pulsegrid-cloud-`.

The ZIP contains `server.js`, the Node package files, and `public/`. It intentionally excludes `.env`, `node_modules`, legacy copies, and previous ZIPs. Configure secrets in the Hostinger environment rather than committing them.

Each firmware device authenticates telemetry, command polling/ACKs, and OTA with a 44-character hexadecimal `DEVICE_CODE` generated deterministically from its MAC. The first 12 characters are the normalized MAC; the remaining 32 are the first half of SHA-256 over `pulsegrid-device-code-v1:` plus that MAC. The burner can calculate the same code from a manually entered MAC. Cloud derives the Device ID and stores only the code's SHA-256 hash. **This deterministic code is not a secret:** anyone who knows the MAC can calculate it and impersonate the device. Device endpoints require HTTPS, but HTTPS does not compensate for a guessable device credential. Existing devices using the former random code must be updated in cloud and reflashed with the deterministic code. The captive portal is limited to Wi-Fi credentials. User API keys remain available for external telemetry and firmware integrations but are not used by the ESP32 firmware.

Firmware releases are published from the dashboard with one target per release: `servo`, `ga25`, or `tenstar`. OTA uses Wi-Fi/HTTPS and does not require an available COM port.

### Tenstar OTA

1. In **Firmware → Nueva publicacion**, select **Tenstar ESP32-C3 · OTA Wi-Fi**, enter a unique version such as `2026.10.26.tenstar-r9`, describe the changes, and select the profile's Python files. The API documentation publisher offers the same model.
2. Use the files listed in `FIRMWARE_FILES` in [Tenstar main](../dispositivos/tenstar/main.py). The shared `ota_boot.py`, `pulsegrid_ota.py`, and `wifi_recovery.py` come from [the Servo profile](../dispositivos/servo/). Include `tenstar_loop.py` when installing the r8+ application. Partial updates are supported when their dependencies are already installed. Do not mix Servo/GA25 application files into a Tenstar release.
3. Publish the release, then go to **Dispositivos → Tenstar menu → Actualizar firmware**. Publishing alone does not install firmware. The menu selects the active Tenstar release, never an archived or generic release.
4. Keep the curtain stopped, finish any calibration session, and maintain stable power. Confirm the update. No motion command is sent. The existing firmware downloads/checks hashes, stages files transactionally, acknowledges, and restarts.
5. Cloud allows up to ten minutes for the download command and then up to 90 seconds for telemetry reporting the requested version. A download ACK alone is not displayed as a completed installation. Failures and missing boot confirmation remain visible; inspect the device before retrying.

The server checks recent Tenstar communication, stopped state, release ownership/compatibility, and a model-specific filename allowlist. The publication bypass cannot override the Tenstar allowlist: `config.py`, calibration state, and manually supplied `pulsegrid_firmware.py` are rejected. Version metadata is generated on-device. Stored calibration and stationary reference remain outside OTA payloads.

Deploy both `server.js` and `public/`; this repository change does not itself update a hosted Cloud. The Tenstar must already have the OTA handler installed (r8 includes it). Cloud tests cover publishing, validation, command dispatch, and boot-confirmation handling with simulated endpoints. A complete OTA installation on the mounted C3 has not been verified; the earlier TLS-memory limitation of the shared updater remains a hardware validation requirement. No serial connection or movement is needed to publish a release.