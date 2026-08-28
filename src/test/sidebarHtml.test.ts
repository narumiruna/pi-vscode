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
  assert.match(html, /current model does not support image attachments/i);
});

test("sidebar keeps primary controls compact and exposes recovery and proposal actions", () => {
  const html = getSidebarHtml(100_000, 5 * 1024 * 1024);

  assert.match(html, /id="model-picker"/);
  assert.match(html, /id="more"/);
  assert.match(html, /id="reconnect"/);
  assert.match(html, /id="retry"/);
  assert.match(html, /type: 'proposalAction'/);
  assert.match(html, /proposal\.status !== 'previewed'/);
  assert.doesNotMatch(html, /id="resume-session"/);
});
