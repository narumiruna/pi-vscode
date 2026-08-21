import assert from "node:assert/strict";
import test from "node:test";
import { imageMimeType, isImageSizeAllowed } from "../attachmentUtils";

test("imageMimeType accepts only Pi-supported image formats", () => {
  assert.equal(imageMimeType("screen.PNG"), "image/png");
  assert.equal(imageMimeType("photo.jpeg"), "image/jpeg");
  assert.equal(imageMimeType("animation.gif"), "image/gif");
  assert.equal(imageMimeType("image.webp"), "image/webp");
  assert.equal(imageMimeType("archive.zip"), undefined);
});

test("image size bounds include the exact maximum", () => {
  assert.equal(isImageSizeAllowed(0, 100), true);
  assert.equal(isImageSizeAllowed(100, 100), true);
  assert.equal(isImageSizeAllowed(101, 100), false);
  assert.equal(isImageSizeAllowed(-1, 100), false);
});
