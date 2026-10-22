# Bundled Pi runtime notices

The VSIX includes `@earendil-works/pi-coding-agent@1.3.0` and its locked production dependencies.
Dependency files and their existing notices remain in `node_modules`.
Only the unused `examples/extensions/doom-overlay` directory is excluded.
That example embeds GPL Doom code and is not needed by the runtime.
Upstream generated JavaScript is not modified.

## Supplemental texts

1. `pi-1.3.0-MIT.txt` supplies the missing root MIT text for the Pi 1.3.0 packages: pi-coding-agent, pi-agent-core, pi-ai, pi-codemode, pi-tui, and pi-telemetry.
   - Source: <https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/LICENSE>.
   - The upstream `v1.3.0` tag resolves to this commit, whose coding-agent package declares version 1.3.0.
2. `marked-18.0.5-MIT.txt` and `highlight.js-11.9.0-BSD-3-Clause.txt` cover the vendor files in Pi's HTML export template.
   - Sources: the exact `marked@18.0.5` and `highlight.js@11.9.0` npm tarballs.
   - These versions differ from dependencies used by the VS Code renderer.
3. `proxy-agent-negotiate-1.1.0-MIT.txt` supplies the upstream author's MIT text for `proxy-agent-negotiate@1.1.0`, which declares MIT but omits a license file.
   - Source: <https://github.com/TooTallNate/proxy-agents/blob/b7e5f7ccce1a3ac5b339cc4c587974e8989cbc16/packages/agent-base/LICENSE>.
   - The `proxy-agent-negotiate@1.1.0` tag resolves to this commit.
   - The negotiate package has no separate license file in that commit; this text is the same author's MIT notice in the same repository.
4. `standardwebhooks-1.1.1-MIT.txt` supplies the missing SDK MIT text.
   - Source: <https://github.com/standard-webhooks/standard-webhooks/blob/b4d2c14fc5b4ccff3ff271e3b087dff812254c59/libraries/LICENSE>.
   - This is the npm `standardwebhooks@1.1.1` gitHead.
   - The repository root license is Apache-2.0, but the SDK-specific `libraries/LICENSE` is MIT.
5. `aws-sdk-Apache-2.0.txt` supplies the full Apache-2.0 text for `@aws-sdk/credential-provider-http@3.972.78`, `@aws-sdk/credential-provider-login@3.972.83`, and `@aws-sdk/nested-clients@3.997.50`, whose npm packages omit it.
   - Source: <https://github.com/aws/aws-sdk-js-v3/blob/7c2f08900ba6f6ea424ac488694de80356541402/LICENSE>.
   - These packages declare Apache-2.0 and identify the AWS SDK for JavaScript Team as author.
   - No runtime-package NOTICE was found in that upstream tree; its only NOTICE is under `codegen/`, which is not distributed here.
6. `data-uri-to-buffer@4.0.1` already includes the complete MIT text and Nathan Rajlich copyright in its packaged `README.md`.
   - No duplicate supplement is needed.

The extracted-artifact smoke checks these supplements and keeps packaged dependency notices.
This inventory is technical distribution evidence, not a legal approval or a vulnerability audit.
