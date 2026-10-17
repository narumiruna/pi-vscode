import assert from "node:assert/strict";

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
  await page.locator("#session-details summary").click();

  let layoutCases = 0;
  for (const width of [180, 220, 280, 400, 600, 960]) {
    for (const height of [420, 800]) {
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
        await page.locator("#session-details summary").click();
        const popup = await page.locator(".session-details-content").boundingBox();
        assert.ok(popup.x >= 0 && popup.x + popup.width <= width, `session details popup at ${width}px`);
        await page.locator("#session-details summary").click();
        const geometry = await page.evaluate(() => {
          const ids = [
            "add-context",
            "model-picker",
            "thinking-level",
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
        const label = JSON.stringify({ width, height, mode, geometry });
        assert.equal(geometry.overflow, false, label);
        for (const control of geometry.controls) {
          assert.ok(control.left >= 0 && control.right <= width && control.top >= 0 && control.bottom <= height, label);
          assert.ok(control.width >= (control.id === "model-picker" ? 30 : 23), label);
        }
        assert.ok(geometry.conversationHeight > 0, label);
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
        layoutCases++;
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
    await state({ status, runtime: foreground });
    assert.equal(
      await page.locator("#status").innerText(),
      status + (!foreground.connected && !/disconnected/i.test(status) ? " · disconnected" : ""),
    );
    assert.equal(await page.locator("#cancel").isVisible(), foreground.cancellable);
    assert.equal(await page.locator("#after-this").isVisible(), foreground.queueable);
    assert.equal(await page.locator("#model-picker").isDisabled(), true);
    if (!foreground.connected) assert.equal(await page.locator("#reconnect").isVisible(), true);
  }
  await post({
    type: "notice",
    message: "Pi reported a runtime warning. View diagnostic before taking further action.",
    level: "warning",
    detailsAvailable: true,
  });
  await page.getByRole("button", { name: "View diagnostic" }).click();
  assert.equal(await page.evaluate(() => window.posted.at(-1).type), "showNoticeDetails");
  await state({ runtime: { ...runtime, busy: true, queueable: false, cancellable: true } });
  await page.locator("#input").press("Enter");
  assert.match(await page.locator("#notice").innerText(), /does not accept queued messages/);

  // Resizing must follow only readers already at the bottom.
  await page.setViewportSize({ width: 600, height: 420 });
  await state({ messages: [{ id: "long", role: "assistant", html: renderSafeMarkdown(prose) }] });
  await page.locator("#input").fill("Growing input\n".repeat(15));
  await page.waitForTimeout(100);
  const bottomGap = () =>
    page
      .locator("#conversation")
      .evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
  assert.ok((await bottomGap()) <= 1);
  await state({
    messages: [{ id: "long", role: "assistant", html: renderSafeMarkdown(prose) }],
    attachments: descriptors,
  });
  await page.waitForTimeout(100);
  assert.ok((await bottomGap()) <= 1);
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
    keyboard: "preview/focus restoration, submission help, session details, queue tab order",
    announcements: "unchanged streaming status does not mutate the live region",
  };
}
