import assert from "node:assert/strict";
import { assertFixedStatus } from "./fixed-status-fixture.mjs";

// Deterministic sidebar states. This harness never starts Pi or a provider.
export async function assertInterface(browser, getSidebarHtml, renderSafeMarkdown) {
  const page = await browser.newPage({ viewport: { width: 600, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.evaluate(() => {
    window.posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (message) => window.posted.push(message) });
  });
  await page.setContent(getSidebarHtml(100000, 5000000));
  const post = (data) => page.evaluate((data) => window.dispatchEvent(new MessageEvent("message", { data })), data);
  const themes = {
    "vscode-dark": {
      foreground: "#cccccc",
      background: "#181818",
      control: "#313131",
      disabled: "#a0a0a0",
      button: "#0078d4",
      buttonText: "#ffffff",
    },
    "vscode-light": {
      foreground: "#333333",
      background: "#ffffff",
      control: "#eeeeee",
      disabled: "#666666",
      button: "#005a9e",
      buttonText: "#ffffff",
    },
    "vscode-high-contrast": {
      foreground: "#ffffff",
      background: "#000000",
      control: "#000000",
      disabled: "#aaaaaa",
      button: "#000000",
      buttonText: "#ffffff",
    },
    "vscode-high-contrast-light": {
      foreground: "#000000",
      background: "#ffffff",
      control: "#ffffff",
      disabled: "#555555",
      button: "#ffffff",
      buttonText: "#000000",
    },
  };
  const theme = async (name) =>
    page.evaluate(
      ({ name, colors }) => {
        document.body.className = name;
        const values = {
          "font-family": "Arial",
          "font-size": "13px",
          foreground: colors.foreground,
          descriptionForeground: colors.foreground,
          disabledForeground: colors.disabled,
          "sideBar-background": colors.background,
          "editor-background": colors.background,
          "editorWidget-background": colors.background,
          "input-background": colors.control,
          "input-foreground": colors.foreground,
          "dropdown-background": colors.control,
          "dropdown-border": colors.foreground,
          "button-background": colors.button,
          "button-foreground": colors.buttonText,
          focusBorder: "#0078d4",
          contrastBorder: colors.foreground,
        };
        for (const [key, value] of Object.entries(values)) document.body.style.setProperty(`--vscode-${key}`, value);
      },
      { name, colors: themes[name] },
    );
  await theme("vscode-dark");
  const images = await page.evaluate(() =>
    [
      [160, 320],
      [480, 120],
      [20, 2000],
    ].map(([width, height], index) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      context.fillStyle = ["#b25555", "#55b255", "#5555b2"][index];
      context.fillRect(0, 0, width, height);
      // Distinct edges expose cropping in a visual review.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, 8);
      context.fillRect(0, height - 8, width, 8);
      const data = canvas.toDataURL("image/png").split(",")[1];
      return {
        type: "imageAsset",
        id: `sha256-${String(index + 1).repeat(64)}`,
        mimeType: "image/png",
        byteLength: atob(data).length,
        data,
        width,
        height,
      };
    }),
  );
  for (const image of images) await post(image);
  const descriptors = images.map((image, index) => ({
    type: "image",
    image: true,
    id: `image-${index}`,
    assetId: image.id,
    width: image.width,
    height: image.height,
    availability: "available",
    label: `${["portrait", "landscape", "very-tall"][index]}-long-filename.png`,
    fullLabel: `${"long-filename-".repeat(8)}${index}.png`,
  }));
  descriptors.push({
    type: "image",
    image: true,
    id: "missing",
    assetId: `sha256-${"f".repeat(64)}`,
    availability: "unavailable",
    label: "missing.png",
    fullLabel: "missing.png",
  });
  const prose = Array.from(
    { length: 35 },
    (_, index) => `Paragraph ${index}: ${"Readable assistant prose with stable line lengths. ".repeat(8)}`,
  ).join("\n\n");
  const runtime = {
    connected: true,
    busy: false,
    sessionFile: "/fixture/session.jsonl",
    sessionId: "full-session-identifier-for-keyboard-copy",
    model: { name: "Claude Sonnet 4.5", provider: "fixture", id: "full-model-identifier" },
    thinkingLevel: "high",
    availableThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    stats: { contextUsage: { percent: 12 } },
  };
  const state = async (extra = {}) =>
    post({ type: "state", status: "Ready", imageSupported: true, runtime, messages: [], attachments: [], ...extra });
  await post({ type: "showSessionDetail" });
  // Empty is not the same as unpersisted. Delete follows sessionFile, never message count.
  await state({ runtime: { ...runtime, sessionFile: undefined, sessionId: undefined } });
  assert.equal(await page.locator("#delete-session").isVisible(), false);
  await state();
  assert.equal(await page.locator("#delete-session").isVisible(), true);
  assert.equal(await page.locator(".welcome-action").count(), 3);
  const openDetails = async (key = "Enter") => {
    const before = await page.evaluate(() => window.posted.length);
    await page.locator("#more").focus();
    await page.keyboard.press(key);
    const requests = await page.evaluate((offset) => window.posted.slice(offset), before);
    assert.equal(requests.length, 1, "More opens only the native action picker");
    assert.equal(requests[0].type, "showMoreActions");
    assert.equal(requests[0].text, await page.locator("#input").inputValue());
    assert.ok(Number.isSafeInteger(requests[0].revision));
    assert.equal(await page.locator("#conversation-details").evaluate((dialog) => dialog.open), false);
    await post({ type: "showConversationDetails" });
    assert.equal(await page.locator("#conversation-details").evaluate((dialog) => dialog.open), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), "conversation-details-close");
    assert.equal(await page.evaluate(() => window.posted.length), before + 1, "details never restore or submit text");
  };
  const closeDetails = async (key = "Escape") => {
    if (key === "Escape") await page.keyboard.press(key);
    else {
      await page.locator("#conversation-details-close").focus();
      await page.keyboard.press(key);
    }
    await page.waitForFunction(
      () => !document.getElementById("conversation-details").open && document.activeElement.id === "more",
    );
  };
  assert.equal(await page.locator("#runtime").isVisible(), true, "idle reserves the primary status line");
  assert.equal(await page.locator("#status").textContent(), "");
  assert.equal(await page.locator("#runtime .status-dot").isVisible(), false);
  assert.equal(await page.locator("#composer-status").isVisible(), false, "an empty draft is visually neutral");
  assert.match(await page.locator("#send").getAttribute("title"), /Enter a message or attach context/);
  assert.match(await page.locator("#composer-status").textContent(), /Enter a message or attach context/);
  assert.ok((await page.locator("#send").getAttribute("aria-describedby")).includes("composer-status"));
  assert.equal(await page.locator("#thinking-level").count(), 0);
  await page.screenshot({ path: "/tmp/pi-composer-idle.png" });
  const fixedStatus = await assertFixedStatus({ page, state, post, runtime, themes, theme, renderSafeMarkdown, prose });
  for (const id of [
    "composer-help",
    "file-discovery-hint",
    "session-details",
    "usage",
    "text-draft-recovery",
    "extension-status",
  ]) {
    assert.equal(
      await page.locator(`#conversation-details #${id}`).count(),
      1,
      `${id} belongs to Conversation details`,
    );
    assert.equal(await page.locator(`#${id}`).isVisible(), false, `${id} is not persistent composer chrome`);
  }
  await page.locator("#input").fill("A draft survives details navigation");
  await page.locator("#input").evaluate((input) => input.setSelectionRange(2, 8));
  await openDetails();
  assert.match(await page.locator("#usage").innerText(), /Context 12%/);
  await page.locator("#composer-help summary").focus();
  await page.keyboard.press("Space");
  assert.equal(await page.locator("#composer-help").evaluate((panel) => panel.open), true);
  assert.match(await page.locator("#composer-hint").innerText(), /Enter.*send/i);
  await page.keyboard.press("Enter");
  await page.locator("#session-details summary").focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  assert.equal(await page.locator("#session").inputValue(), runtime.sessionId);
  assert.equal(await page.evaluate(() => document.activeElement.id), "session");
  await page.locator("#session").selectText();
  assert.equal(
    await page.locator("#session").evaluate((input) => input.selectionEnd - input.selectionStart),
    runtime.sessionId.length,
  );
  await closeDetails("Enter");
  assert.equal(await page.locator("#input").inputValue(), "A draft survives details navigation");
  assert.deepEqual(
    await page.locator("#input").evaluate((input) => [input.selectionStart, input.selectionEnd]),
    [2, 8],
    "details navigation preserves the composer selection",
  );
  await openDetails("Space");
  await closeDetails();
  assert.equal(await page.locator("#input").inputValue(), "A draft survives details navigation");

  let layoutCases = 0;
  for (const name of Object.keys(themes)) {
    await theme(name);
    for (const width of [159, 169, 180, 220, 280, 400, 600, 960]) {
      for (const height of [344, 358, 420, 800]) {
        await page.setViewportSize({ width, height });
        for (const mode of ["idle", "running", "multiline", "attachments", "disconnected", "uncertain"]) {
          const running = mode === "running";
          const disconnected = mode === "disconnected" || mode === "uncertain";
          await state({
            runtime: {
              ...runtime,
              connected: !disconnected,
              busy: running,
              queueable: running,
              cancellable: running,
              recoveredDrafts: mode === "uncertain" ? [{ id: "recovery", text: "Check history", uncertain: true }] : [],
            },
            retryAvailable: disconnected,
            historyRecoveryAvailable: disconnected,
            messages: [{ id: "long", role: "assistant", html: renderSafeMarkdown(prose) }],
            attachments: mode === "attachments" ? descriptors : [],
          });
          await page.locator("#input").fill(mode === "multiline" ? "A growing draft\n".repeat(12) : "A draft");
          await openDetails();
          const popup = await page.locator("#conversation-details").boundingBox();
          assert.ok(
            popup.x >= 0 && popup.x + popup.width <= width && popup.y >= 0 && popup.y + popup.height <= height,
            `bounded details dialog at ${width}x${height} in ${name}: ${JSON.stringify(popup)}`,
          );
          assert.equal(
            await page
              .locator("#conversation-details")
              .evaluate(
                (dialog) =>
                  dialog.scrollWidth <= dialog.clientWidth && /auto|scroll/.test(getComputedStyle(dialog).overflowY),
              ),
            true,
            "details must scroll vertically, not overflow horizontally",
          );
          await closeDetails();
          assert.equal(
            await page.locator("#input").inputValue(),
            mode === "multiline" ? "A growing draft\n".repeat(12) : "A draft",
          );
          assert.equal(
            await page.locator("#attachments .attachment-remove").count(),
            mode === "attachments" ? descriptors.length : 0,
          );
          const geometry = await page.evaluate(() => {
            const ids = [
              "add-context",
              "model-picker",
              "more",
              "send",
              "cancel",
              "after-this",
              "runtime",
              "input",
              "reconnect",
              "recover-queue",
              "retry",
              "refresh-history",
            ];
            const controls = ids
              .map((id) => document.getElementById(id))
              .filter((element) => element.getClientRects().length)
              .map((element) => {
                const rect = element.getBoundingClientRect();
                return {
                  id: element.id,
                  left: rect.left,
                  right: rect.right,
                  top: rect.top,
                  bottom: rect.bottom,
                  width: rect.width,
                };
              });
            return {
              controls,
              overflow: document.documentElement.scrollWidth > innerWidth,
              conversationHeight: document.getElementById("conversation").clientHeight,
            };
          });
          const label = JSON.stringify({ name, width, height, mode, geometry });
          assert.equal(geometry.overflow, false, label);
          for (const control of geometry.controls) {
            assert.ok(
              control.left >= 0 && control.right <= width && control.top >= 0 && control.bottom <= height,
              label,
            );
            assert.ok(control.width >= (control.id === "model-picker" ? 30 : 23), label);
          }
          assert.ok(geometry.conversationHeight > 0, label);
          if (!running) {
            const row = ["add-context", "model-picker", "send"].map((id) =>
              geometry.controls.find((control) => control.id === id),
            );
            assert.ok(
              row.every((control) => Math.abs(control.top - row[0].top) <= 1),
              `one compact idle action row: ${label}`,
            );
          }
          const model = await page
            .locator("#model-label")
            .evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
          if (width >= 600) assert.equal(model.client, model.scroll, label);
          const buttons = await page.locator(".composer-actions button:visible").evaluateAll((elements) =>
            elements.map((element) => {
              const { left, right, top, bottom } = element.getBoundingClientRect();
              return { left, right, top, bottom };
            }),
          );
          for (let i = 0; i < buttons.length; i++)
            for (let j = i + 1; j < buttons.length; j++) {
              const a = buttons[i];
              const b = buttons[j];
              assert.ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, label);
            }
          if (name === "vscode-dark" && width === 220 && height === 420 && mode === "idle") {
            await page.screenshot({ path: "/tmp/pi-composer-narrow.png" });
          }
          layoutCases++;
        }
      }
    }
  }
  await page.setViewportSize({ width: 960, height: 800 });
  await state({
    messages: [
      { id: "long", role: "assistant", html: renderSafeMarkdown(prose) },
      { id: "images", role: "user", html: "<p>Images</p>", attachments: descriptors },
    ],
    attachments: descriptors,
  });
  await page.locator(".transcript-image img").first().waitFor();
  const proseWidth = await page
    .locator(".assistant .content p")
    .first()
    .evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      limit: getComputedStyle(element).maxWidth,
      content: element.parentElement.clientWidth,
    }));
  assert.ok(proseWidth.width < proseWidth.content - 100);
  assert.ok(Math.abs(proseWidth.width - parseFloat(proseWidth.limit)) < 1);
  for (const selector of [".composer-image img", ".transcript-image img"]) {
    for (const image of await page.locator(selector).all())
      assert.equal(await image.evaluate((image) => getComputedStyle(image).objectFit), "contain");
  }
  const transcriptGeometry = await page
    .locator(".transcript-image")
    .first()
    .evaluate((button) => {
      const image = button.querySelector("img").getBoundingClientRect();
      const label = button.querySelector(".image-label").getBoundingClientRect();
      return { width: button.clientWidth, imageBottom: image.bottom, labelTop: label.top };
    });
  assert.ok(transcriptGeometry.width <= 180);
  assert.ok(transcriptGeometry.labelTop >= transcriptGeometry.imageBottom);
  assert.equal(await page.locator(".transcript-image").last().innerText(), "Image unavailable\nmissing.png");
  for (const selector of [".composer-image", ".transcript-image"]) {
    const trigger = page.locator(selector).first();
    await trigger.focus();
    assert.match(await trigger.getAttribute("aria-label"), /Open image preview/);
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#image-preview").evaluate((dialog) => dialog.open), true);
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      (selector) =>
        document.activeElement === document.querySelector(selector) &&
        !document.querySelector("#preview-image").hasAttribute("src"),
      selector,
    );
    assert.equal(await trigger.evaluate((element) => document.activeElement === element), true);
  }
  // Close events are deferred. Opening another image in the same task must retain its payload and focus.
  await page.evaluate(() => {
    document.querySelector(".composer-image").click();
    document.querySelector("#preview-close").click();
    document.querySelectorAll(".transcript-image")[1].click();
  });
  await page.waitForTimeout(100);
  assert.equal(await page.locator("#image-preview").evaluate((dialog) => dialog.open), true);
  assert.ok((await page.locator("#preview-image").getAttribute("src"))?.startsWith("data:image/png;base64,"));
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("#preview-image").hasAttribute("src"));
  await page.locator(".attachment-remove").first().click();
  assert.equal(await page.evaluate(() => window.posted.at(-1).type), "removeAttachment");
  assert.equal(await page.locator("#image-preview").evaluate((dialog) => dialog.open), false);

  // Both buttons and shortcuts use exactly one submission path, with captured host-owned attachments.
  await theme("vscode-dark");
  await page.setViewportSize({ width: 600, height: 800 });
  await state({
    runtime: { ...runtime, busy: true, queueable: true, cancellable: true },
    attachments: descriptors.slice(0, 1),
  });
  await page.locator("#input").focus();
  for (const id of ["add-context", "cancel", "after-this", "send"]) {
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id), id, "queue focus order follows visual order");
  }
  const repeated = { status: "Running read…", runtime: { ...runtime, busy: true, queueable: true, cancellable: true } };
  await state(repeated);
  await page.evaluate(() => {
    window.statusMutations = 0;
    window.statusObserver = new MutationObserver((records) => {
      window.statusMutations += records.length;
    });
    window.statusObserver.observe(document.getElementById("status"), {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
  for (let index = 0; index < 5; index++) await state(repeated);
  assert.equal(
    await page.evaluate(() => window.statusMutations),
    0,
    "unchanged streaming status must not repeat live announcements",
  );
  await page.evaluate(() => window.statusObserver.disconnect());
  await state({
    runtime: { ...runtime, busy: true, queueable: true, cancellable: true },
    attachments: descriptors.slice(0, 1),
  });
  for (const [action, kind] of [
    ["#send", "steer"],
    ["#after-this", "followUp"],
    ["Enter", "steer"],
    ["Alt+Enter", "followUp"],
  ]) {
    await page.locator("#input").fill("Continue");
    const before = await page.evaluate(() => window.posted.length);
    if (action.startsWith("#")) await page.locator(action).click();
    else await page.locator("#input").press(action);
    assert.equal(await page.evaluate(() => window.posted.length), before + 1);
    const message = await page.evaluate(() => window.posted.at(-1));
    assert.equal(message.type, "queueInstruction");
    assert.equal(message.kind, kind);
    assert.equal(message.text, "Continue");
    assert.equal(await page.locator("#send").isDisabled(), true);
    assert.equal(await page.locator(".composer-image").count(), 1);
    await post({ type: "sendRejected" });
  }
  for (const [status, extra] of [
    ["Starting Pi…", {}],
    ["Running read…", {}],
    ["Pi is thinking…", {}],
    ["Generating response…", {}],
    ["Finishing Pi response…", { queueable: false }],
    ["Cancelling Pi request…", { queueable: false }],
    ["Disconnected · Reconnect available", { connected: false, queueable: false, cancellable: false }],
    [
      "Queued delivery is uncertain",
      {
        connected: false,
        queueable: false,
        cancellable: false,
        recoveredDrafts: [{ id: "recovered", text: "Uncertain", uncertain: true }],
      },
    ],
  ]) {
    const foreground = { ...runtime, busy: true, queueable: true, cancellable: true, ...extra };
    await page.locator("#input").fill(""); // An empty draft must not replace foreground progress.
    await state({ status, runtime: foreground });
    assert.equal(
      await page.locator("#status").innerText(),
      foreground.connected && !foreground.queueable
        ? "This request cannot accept queued messages. Wait or use Stop."
        : status + (!foreground.connected && !/disconnected/i.test(status) ? " · disconnected" : ""),
    );
    assert.equal(await page.locator("#cancel").isVisible(), foreground.cancellable);
    assert.equal(await page.locator("#after-this").isVisible(), foreground.queueable);
    assert.equal(await page.locator("#model-picker").isDisabled(), true);
    assert.equal(await page.locator("#runtime").isVisible(), true);
    assert.equal(await page.locator("#runtime").count(), 1, "there is only one foreground progress line");
    assert.equal(
      await page.locator("#composer > #runtime + .composer-box").count(),
      1,
      "progress stays above the editor",
    );
    assert.equal(await page.locator("#conversation #runtime").count(), 0);
    assert.equal(await page.locator("#more").isEnabled(), true);
    if (status === "Pi is thinking…") await page.screenshot({ path: "/tmp/pi-composer-working.png" });
    const draft = await page.locator("#input").inputValue();
    await openDetails();
    await closeDetails();
    assert.equal(await page.locator("#input").inputValue(), draft);
    if (!foreground.connected) assert.equal(await page.locator("#reconnect").isVisible(), true);
  }
  // Recovery cannot disappear when the transcript is hidden by the Sessions view.
  await post({ type: "showSessionsLayer" });
  await state({
    status: "Disconnected · Reconnect available",
    runtime: { ...runtime, connected: false },
    retryAvailable: true,
    historyRecoveryAvailable: true,
  });
  for (const id of ["runtime", "reconnect", "retry", "refresh-history"]) {
    assert.equal(await page.locator(`#${id}`).isVisible(), true, `${id} remains available in Sessions`);
  }
  await openDetails();
  await closeDetails();
  await post({ type: "showSessionDetail" });
  await post({
    type: "notice",
    message: "Pi stopped, but descendant cleanup is unverified. Check running processes before continuing.",
    level: "warning",
    outputAvailable: true,
  });
  assert.equal(await page.locator("#notice").getByRole("button", { name: "Dismiss" }).count(), 0);
  await page.screenshot({ path: "/tmp/pi-composer-warning.png" });
  const showOutput = page.getByRole("button", { name: "Show Output", exact: true });
  await showOutput.focus();
  await showOutput.press("Enter");
  assert.equal(await page.evaluate(() => window.posted.at(-1).type), "showOutput");
  assert.equal(await showOutput.evaluate((element) => element === document.activeElement), true);
  await state({ runtime: { ...runtime, busy: true, queueable: false, cancellable: true } });
  await page.locator("#input").fill("Blocked draft");
  await page.locator("#input").press("Enter");
  assert.match(await page.locator("#notice").innerText(), /does not accept queued messages/);

  // Relevant blockers remain visible; neutral empty-draft instructions stay accessible without a visible row.
  await page.setViewportSize({ width: 280, height: 420 });
  for (const [extra, text, reason] of [
    [{ runtime: { ...runtime, connected: false } }, "draft", /disconnected.*Reconnect/],
    [
      { runtime: { ...runtime, busy: true, queueable: false, cancellable: true } },
      "draft",
      /cannot accept queued messages/,
    ],
    [
      {
        runtime: {
          ...runtime,
          busy: true,
          queueable: true,
          cancellable: true,
          pendingQueue: {
            steering: Array.from({ length: 10 }, (_, index) => ({ id: String(index), text: "queued" })),
            followUp: [],
          },
        },
      },
      "draft",
      /queue is full/,
    ],
    [
      { runtime: { ...runtime, busy: true, queueable: true, cancellable: true } },
      "/compact",
      /Slash commands cannot be queued/,
    ],
    [{ attachments: descriptors.slice(0, 1) }, "!pwd", /Direct shell.*remove attachments/],
    [{ imageSupported: false, attachments: descriptors.slice(0, 1) }, "draft", /cannot use images.*Choose/],
    [{ backgroundSubmissionPending: true }, "draft", /Starting a background agent/],
  ]) {
    await state(extra);
    await page.locator("#input").fill(text);
    const status = page.locator("#composer-status");
    assert.equal(await status.isVisible(), false);
    assert.equal(await status.getAttribute("hidden"), "");
    assert.equal(await status.getAttribute("data-state"), "blocked");
    assert.match(await status.textContent(), reason);
    if (extra.runtime?.connected !== false) assert.match(await page.locator("#status").innerText(), reason);
    else assert.match(await page.locator("#status").innerText(), /disconnected/i);
    assert.equal(await page.locator("#send").getAttribute("title"), await status.textContent());
    assert.equal(await page.locator("#after-this").getAttribute("title"), await status.textContent());
    assert.equal(await page.locator("#send").isDisabled(), true);
    assert.equal(await page.locator("#composer-help").evaluate((element) => element.open), false);
  }
  await state();
  await page.locator("#input").fill("");
  assert.equal(await page.locator("#composer-status").isVisible(), false);
  assert.match(await page.locator("#composer-status").textContent(), /Enter a message or attach context/);
  assert.equal(await page.locator("#send").getAttribute("title"), await page.locator("#composer-status").textContent());
  await page.locator("#input").fill("Ready");
  assert.equal(await page.locator("#composer-status").isVisible(), false);
  await page.evaluate(() => {
    window.blockerMutations = 0;
    window.blockerObserver = new MutationObserver((records) => {
      window.blockerMutations += records.length;
    });
    window.blockerObserver.observe(document.getElementById("composer-status"), {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  for (let index = 0; index < 5; index++) await state({ status: "Unrelated runtime status" });
  assert.equal(
    await page.evaluate(() => window.blockerMutations),
    0,
    "ready streaming updates do not repeat announcements",
  );
  await page.evaluate(() => window.blockerObserver.disconnect());
  // Transient capture/restoration/loading/send states share the same explanation calculation.
  for (const [flag, reason] of [
    ["capture", /Capturing a file attachment/],
    ["recovery", /Restoring draft attachments/],
    ["image", /Loading pasted images/],
    ["sending", /Sending this message/],
    ["newSession", /before starting a new session/],
  ]) {
    await page.evaluate((flag) => {
      const previousCompletion = fileCompletion;
      if (flag === "capture") fileCompletion = { busy: true, refresh() {} };
      if (flag === "recovery") recoveredDraftPending = { id: "fixture", text: "draft" };
      if (flag === "image") pendingImageReads = 1;
      if (flag === "sending") submissionPending = true;
      if (flag === "newSession") {
        sessionsLayerVisible = true;
        busy = true;
      }
      updateSendState();
      fileCompletion = previousCompletion;
    }, flag);
    assert.match(await page.locator("#composer-status").textContent(), reason);
    assert.match(await page.locator("#status").innerText(), reason);
    assert.equal(await page.locator("#composer-status").isVisible(), false);
    await page.evaluate(() => {
      recoveredDraftPending = undefined;
      pendingImageReads = 0;
      submissionPending = false;
      sessionsLayerVisible = false;
      busy = false;
      updateSendState();
    });
  }

  // Resizing must follow only readers already at the bottom.
  await page.setViewportSize({ width: 600, height: 420 });
  await state({ messages: [{ id: "long", role: "assistant", html: renderSafeMarkdown(prose) }] });
  // Previous cases deliberately changed composer state; start this independent following check at latest.
  await page.locator("#jump-to-latest").evaluate((button) => button.click());
  await page.locator("#input").fill("Growing input\n".repeat(15));
  await page.waitForTimeout(100);
  const bottomGap = () =>
    page
      .locator("#conversation")
      .evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
  assert.ok(
    (await bottomGap()) <= 1,
    JSON.stringify(
      await page.evaluate(() => ({
        pinned: conversationPinnedToBottom,
        previousHeight: conversationClientHeight,
        height: conversationElement.clientHeight,
        scrollHeight: conversationElement.scrollHeight,
        scrollTop: conversationElement.scrollTop,
        programmatic: programmaticConversationScrollTop,
      })),
    ),
  );
  await state({
    messages: [{ id: "long", role: "assistant", html: renderSafeMarkdown(prose) }],
    attachments: descriptors,
  });
  await page.waitForTimeout(100);
  assert.ok(
    (await bottomGap()) <= 1,
    JSON.stringify(
      await page.evaluate(() => ({
        pinned: conversationPinnedToBottom,
        previousHeight: conversationClientHeight,
        height: conversationElement.clientHeight,
        scrollHeight: conversationElement.scrollHeight,
        scrollTop: conversationElement.scrollTop,
        programmatic: programmaticConversationScrollTop,
      })),
    ),
  );
  await page.locator("#conversation").hover();
  await page.mouse.wheel(0, -10000);
  await page.waitForTimeout(100);
  await page.locator("#conversation").evaluate((element) => {
    element.scrollTop = 40;
  });
  await page.waitForTimeout(100);
  await page.locator("#input").fill("Short draft");
  await state({ messages: [{ id: "long", role: "assistant", html: renderSafeMarkdown(prose + "\n\nStream update") }] });
  await page.waitForTimeout(100);
  assert.equal(await page.locator("#conversation").evaluate((element) => element.scrollTop), 40);
  const latest = page.locator("#jump-to-latest");
  assert.equal(await latest.isVisible(), true);
  assert.match(await latest.innerText(), /New output/);
  const beforeNavigation = await page.evaluate(() => window.posted.length);
  await latest.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(100);
  assert.ok((await bottomGap()) <= 1);
  assert.equal(await latest.isVisible(), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), "input");
  assert.equal(await page.locator("#input").inputValue(), "Short draft");
  assert.equal(
    await page.evaluate(() => window.posted.length),
    beforeNavigation,
    "latest navigation never sends a request",
  );
  await page.locator("#conversation").hover();
  await page.mouse.wheel(0, -10000);
  await page.waitForTimeout(100);
  await state({
    messages: [{ id: "long", role: "assistant", html: renderSafeMarkdown(prose + "\n\nStream update") }],
    status: "Only a status change",
  });
  assert.equal(await latest.innerText(), "Jump to latest", "status-only updates are not new transcript output");
  await state({ runtime: { ...runtime, sessionId: "different-session", sessionFile: "/fixture/other.jsonl" } });
  assert.equal(await latest.isVisible(), false, "session changes reset navigation");

  // Control catalog and branch drafts use only host-owned, revision-bound browser messages.
  await state({
    runtime: {
      ...runtime,
      commands: [
        { name: "vscode-pi-control", description: "Internal" },
        { name: "reload", description: "Shadowed" },
      ],
    },
  });
  await page.locator("#input").fill("/reload");
  assert.equal(await page.locator("#slash-commands button").count(), 1);
  assert.equal(
    await page
      .locator("#slash-commands")
      .innerText()
      .then((text) => text.includes("Shadowed")),
    false,
  );
  await page.locator("#input").fill("");
  await post({ type: "restoreBranchDraft", text: "Selected user prompt" });
  assert.equal(await page.locator("#input").inputValue(), "Selected user prompt");
  await page.locator("#input").fill("Newer draft");
  await post({ type: "restoreBranchDraft", text: "Must not replace", expectedRevision: -1 });
  assert.equal(await page.locator("#input").inputValue(), "Newer draft");
  assert.match(await page.locator("#notice").innerText(), /draft changed/);

  // A non-blocking notice can be dismissed; blocking warning controls cannot disappear this way.
  await post({ type: "notice", level: "info", message: "Resources refreshed." });
  await page.locator("#notice").getByRole("button", { name: "Dismiss" }).click();
  assert.equal(await page.locator("#notice").textContent(), "");
  // Theme screenshots are temporary review evidence, not committed assets. Native UI tests cover zoom.
  for (const name of Object.keys(themes)) {
    await theme(name);
    await page.setViewportSize({ width: 400, height: 800 });
    await state({ runtime: { ...runtime, busy: true, queueable: true, cancellable: true }, attachments: descriptors });
    await page.waitForTimeout(200); // Let theme color transitions settle before visual review.
    await page.screenshot({ path: `/tmp/pi-interface-${name}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  assert.deepEqual(errors, []);
  await page.close();
  return {
    layoutCases,
    imageCases: descriptors.length,
    phases: 8,
    themes: Object.keys(themes),
    keyboard: "preview/focus restoration, More/details Close/Escape, submission help, session ID copy, queue Tab order",
    quietIdle: "empty reserved status line; no Ready text, visible empty-draft hint, or separate thinking selector",
    details: "bounded in four themes and narrow/short layouts; no automatic restore, submission, or draft loss",
    progress: "single fixed composer line; Sessions recovery retained",
    fixedStatus,
    captures: ["idle", "working", "warning", "narrow"].map((state) => `/tmp/pi-composer-${state}.png`),
    announcements: "unchanged streaming status does not mutate the live region",
  };
}
