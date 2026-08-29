import assert from "node:assert/strict";
import test from "node:test";
import { getSidebarHtml } from "../sidebarHtml";

test("sidebar composer forwards pasted clipboard images with client-side bounds", () => {
  const html = getSidebarHtml(100_000, 123_456);

  assert.match(html, /input\.addEventListener\('paste', attachPastedImages\)/);
  assert.match(html, /type: 'pasteImage'/);
  assert.match(html, /file\.size > 123456/);
  assert.match(html, /image\/png/);
  assert.match(html, /image\/webp/);
  assert.match(html, /type: 'removeAttachment'/);
  assert.match(html, /let pendingImageReads = 0/);
  assert.match(html, /pendingImageReads > 0/);
  assert.match(html, /reader\.addEventListener\('loadend'/);
  assert.match(html, /Wait for pasted images to finish loading/);
  assert.match(html, /current model does not support image attachments/i);
});

test("sidebar keeps primary controls compact and exposes recovery and proposal actions", () => {
  const html = getSidebarHtml(100_000, 5 * 1024 * 1024);

  assert.match(html, /id="model-picker"/);
  assert.match(html, /id="more"/);
  assert.match(html, /id="handoff-agent"[^>]*hidden>Implement Plan<\/button>/);
  assert.match(html, /state\.runtime\.mode !== 'plan'/);
  assert.match(html, /handoff-agent'\)\.disabled = true;\s+vscode\.postMessage\(\{ type: 'handoffAgent'/);
  assert.match(html, /id="reconnect"/);
  assert.match(html, /id="retry"/);
  assert.match(html, /id="refresh-history"/);
  assert.match(html, /type: 'refreshHistory'/);
  assert.match(html, /type: 'proposalAction'/);
  assert.match(html, /proposal\.status !== 'previewed'/);
  assert.match(html, /\['previewing', 'applying', 'rejecting'\]\.includes\(proposal\.status\)/);
  assert.match(html, /setInput'[\s\S]*composerRevision \+= 1[\s\S]*updateSendState\(\)/);
  assert.match(html, /clearInput'[\s\S]*composerRevision === message\.expectedRevision[\s\S]*input\.value === message\.expectedText[\s\S]*updateSendState\(\)/);
  assert.match(html, /showMoreActions', text: input\.value, revision: composerRevision/);
  assert.match(html, /input\.addEventListener\('input', \(\) => \{ composerRevision \+= 1/);
  assert.match(html, /let submissionPending = false/);
  assert.match(html, /submissionPending = true;\s+updateSendState\(\);\s+vscode\.postMessage/);
  assert.match(html, /message\.type === 'sendRejected'[\s\S]*submissionPending = false/);
  assert.match(html, /let backgroundSubmissionPending = false/);
  assert.match(html, /submissionPending \|\| backgroundSubmissionPending \|\| \(attachedImages/);
  assert.match(html, /backgroundSubmissionPending = Boolean\(state\.backgroundSubmissionPending\)/);
  assert.match(html, /busy \|\| submissionPending \|\| backgroundSubmissionPending \|\| imageLoading/);
  assert.match(html, /Starting background agent/);
  assert.match(html, /messages\.filter\(message => message\.role !== 'assistant' \|\| Boolean\(message\.html\)\)/);
  assert.match(html, /for \(const message of visibleMessages\)/);
  assert.doesNotMatch(html, /id="resume-session"/);
});
