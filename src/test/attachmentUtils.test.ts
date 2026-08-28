import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeBoundedBase64Image,
  imageMimeType,
  isImageSizeAllowed,
  isSupportedImageMimeType,
} from "../attachmentUtils";

test("imageMimeType accepts only Pi-supported image formats", () => {
  assert.equal(imageMimeType("screen.PNG"), "image/png");
  assert.equal(imageMimeType("photo.jpeg"), "image/jpeg");
  assert.equal(imageMimeType("animation.gif"), "image/gif");
  assert.equal(imageMimeType("image.webp"), "image/webp");
  assert.equal(imageMimeType("archive.zip"), undefined);
});

test("supported image MIME types match Pi image attachments", () => {
  assert.equal(isSupportedImageMimeType("image/png"), true);
  assert.equal(isSupportedImageMimeType("IMAGE/JPEG"), true);
  assert.equal(isSupportedImageMimeType("image/svg+xml"), false);
  assert.equal(isSupportedImageMimeType("text/plain"), false);
});

test("pasted image Base64 must be canonical and remain within decoded bounds", () => {
  assert.deepEqual(decodeBoundedBase64Image("aW1hZ2U=", 5), Buffer.from("image"));
  assert.equal(decodeBoundedBase64Image("aW1hZ2U=", 4), undefined);
  assert.equal(decodeBoundedBase64Image("not base64", 100), undefined);
  assert.equal(decodeBoundedBase64Image("", 100), undefined);
});

test("image size bounds include the exact maximum", () => {
  assert.equal(isImageSizeAllowed(0, 100), true);
  assert.equal(isImageSizeAllowed(100, 100), true);
  assert.equal(isImageSizeAllowed(101, 100), false);
  assert.equal(isImageSizeAllowed(-1, 100), false);
});
