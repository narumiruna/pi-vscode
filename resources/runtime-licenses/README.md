# Bundled Pi runtime notices

The VSIX includes `@earendil-works/pi-coding-agent@1.5.2` and its locked production dependencies.
Dependency files and their existing notices remain in `node_modules`.
Only the unused `examples/extensions/doom-overlay` directory is excluded.
That example embeds GPL Doom code and is not needed by the runtime.
Upstream generated JavaScript is not modified.

## Supplemental texts

1. `pi-1.5.2-MIT.txt` supplies the missing root MIT text for the Pi 1.5.2 packages: pi-coding-agent, pi-agent-core, pi-ai, pi-codemode, pi-mcp, pi-schema, pi-tui, and pi-telemetry.
   - Source: <https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/LICENSE>.
   - The upstream `v1.5.2` tag resolves to this commit, whose coding-agent package declares version 1.5.2.
   - All eight installed packages match the production lock at 1.5.2, declare MIT in their package metadata and npm metadata, and omit root license files.
   - The supplemental text matches this source byte-for-byte; coverage here is verified for 1.5.2, not later versions.
2. `marked-18.0.11-MIT.txt` and `highlight.js-11.9.0-BSD-3-Clause.txt` cover the vendor files in Pi 1.5.2's HTML export template.
   - The installed vendor headers identify marked 18.0.11 and highlight.js 11.9.0; these versions differ from dependencies used by the VS Code renderer.
   - The marked text matches `node_modules/@earendil-works/pi-tui/node_modules/marked/LICENSE` byte-for-byte; that installed package and its production lock entry are 18.0.11.
   - Verified marked source: <https://github.com/markedjs/marked/blob/53cb13f13fc13d433269248c5caa255ffa1361ee/LICENSE>.
   - Both the upstream `v18.0.11` tag and npm `marked@18.0.11` gitHead identify this commit, whose license matches the installed text byte-for-byte.
   - npm metadata declares MIT and identifies the exact tarball: <https://registry.npmjs.org/marked/-/marked-18.0.11.tgz>.
   - The full marked text includes the Markdown copyright and redistribution terms; retain these terms as well as the MIT notice.
   - The unchanged highlight.js text was sourced from the exact `highlight.js@11.9.0` npm tarball: <https://registry.npmjs.org/highlight.js/-/highlight.js-11.9.0.tgz>.
   - This inventory covers only these embedded vendor versions; recheck notices when either version changes.
3. `proxy-agent-negotiate-1.1.0-MIT.txt` supplies the upstream author's MIT text for `proxy-agent-negotiate@1.1.0`, which declares MIT but omits a license file.
   - Source: <https://github.com/TooTallNate/proxy-agents/blob/b7e5f7ccce1a3ac5b339cc4c587974e8989cbc16/packages/agent-base/LICENSE>.
   - The `proxy-agent-negotiate@1.1.0` tag resolves to this commit.
   - The negotiate package has no separate license file in that commit; this text is the same author's MIT notice in the same repository.
4. `standardwebhooks-1.1.1-MIT.txt` supplies the missing SDK MIT text.
   - Source: <https://github.com/standard-webhooks/standard-webhooks/blob/b4d2c14fc5b4ccff3ff271e3b087dff812254c59/libraries/LICENSE>.
   - This is the npm `standardwebhooks@1.1.1` gitHead.
   - The repository root license is Apache-2.0, but the SDK-specific `libraries/LICENSE` is MIT.
5. `aws-sdk-Apache-2.0.txt` supplies the full Apache-2.0 text for `@aws-sdk/credential-provider-http@3.972.86`, `@aws-sdk/credential-provider-login@3.972.92`, and `@aws-sdk/nested-clients@3.998.3`, whose npm packages omit it.
   - Source: <https://github.com/aws/aws-sdk-js-v3/blob/7c2f08900ba6f6ea424ac488694de80356541402/LICENSE>.
   - These versions match the production lock and installed packages, which omit root license files.
   - Installed package metadata and npm metadata declare Apache-2.0 and identify the AWS SDK for JavaScript Team as author for all three versions.
   - The supplemental text matches the linked upstream license byte-for-byte; this verification does not cover later package versions.
   - No runtime-package NOTICE was found in that upstream tree; its only NOTICE is under `codegen/`, which is not distributed here.
6. `data-uri-to-buffer@4.0.1` already includes the complete MIT text and Nathan Rajlich copyright in its packaged `README.md`.
   - No duplicate supplement is needed.

## Validation limits

The current Pi and marked supplemental texts are byte-identical to their previous-version copies.
The extracted-artifact smoke fixture references the current filenames.
Dependency notices and the other supplemental texts are preserved.
Verification used the production lock, installed npm assets, read-only GitHub API requests, and npm metadata; no runtime or live provider was started.

This inventory is technical distribution evidence, not a legal approval or a vulnerability audit.
