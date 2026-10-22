---
"narumi-pi": minor
---

Bundle Pi 1.3.0 as the default runtime without requiring a separate Pi or Node.js installation.
Reuse existing Pi configuration, credentials, resources and sessions on the workspace Extension Host.
Keep nonempty `pi.executablePath` overrides, including saved `pi`, unchanged; resetting an override uses the resulting effective override or bundled default.
Manage bundled runtime updates through extension releases and fail without PATH fallback when bundled assets are missing or invalid.
