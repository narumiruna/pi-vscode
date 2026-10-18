// Loaded only in a disposable configured Pi process. Never loaded in the Extension Host.

import { readFileSync, writeSync } from "node:fs";
import path from "node:path";
import {
  type CreateAgentSessionRuntimeFactory,
  CredentialSynchronizationError,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type ExtensionAPI,
  ModelRuntime,
  parseSessionEntries,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";

const protocol = "pi-vscode-isolated-v1";
const maxFrame = 16_384;

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const controller = new AbortController();
    let answer: { id: number; resolve: (value: string) => void; reject: () => void } | undefined;
    let first: ((value: Record<string, unknown>) => void) | undefined;
    const request = new Promise<Record<string, unknown>>((resolve) => {
      first = resolve;
    });
    const send = (fields: Record<string, unknown>): void => {
      const text = JSON.stringify({ protocol, ...fields });
      if (Buffer.byteLength(text) > maxFrame) throw new Error("frame");
      // Pi redirects ordinary startup stdout to diagnostics until session_start finishes.
      // Use the owned protocol pipe directly; do not depend on Pi's internal stdout wrapper.
      writeSync(1, `${text}\n`);
    };
    const cancel = (): void => {
      if (controller.signal.aborted) return;
      controller.abort();
      answer?.reject();
      answer = undefined;
      process.stdin.pause();
    };
    let input = Buffer.alloc(0);
    const receive = (bytes: Buffer): void => {
      if (controller.signal.aborted) return;
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const newline = bytes.indexOf(10, offset);
          const end = newline < 0 ? bytes.length : newline;
          if (input.length + end - offset > maxFrame) throw new Error("frame");
          input = Buffer.concat([input, bytes.subarray(offset, end)]);
          if (newline < 0) return;
          const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input));
          input = Buffer.alloc(0);
          offset = newline + 1;
          if (!value || value.protocol !== protocol || typeof value !== "object") throw new Error("protocol");
          if (value.type === "cancel") {
            cancel();
            return;
          }
          if (first && value.type === "request") {
            const resolve = first;
            first = undefined;
            resolve(value);
          } else if (
            answer &&
            value.type === "answer" &&
            value.id === answer.id &&
            typeof value.value === "string" &&
            value.value.length <= 8_192
          ) {
            const pending = answer;
            answer = undefined;
            pending.resolve(value.value);
          } else throw new Error("protocol");
        }
      } catch {
        cancel();
      }
    };
    process.stdin.on("data", receive);
    process.stdin.once("end", cancel);
    const timer = setTimeout(cancel, 300_000);
    try {
      if (VERSION !== "1.3.0") {
        send({ type: "unsupported" });
        return;
      }
      send({ type: "ready", version: VERSION });
      const value = await Promise.race([
        request,
        new Promise<never>((_resolve, reject) =>
          controller.signal.addEventListener("abort", () => reject(), { once: true }),
        ),
      ]);
      const operation = value.operation;
      if (operation === "discover" || operation === "login" || operation === "logout") {
        if (typeof value.agentDir !== "string" || !path.isAbsolute(value.agentDir)) throw new Error("request");
        const storeDirectory = operation === "discover" ? process.env.PI_CODING_AGENT_DIR : value.agentDir;
        if (!storeDirectory) throw new Error("missing isolated directory");
        const models = await ModelRuntime.create({
          authPath: path.join(storeDirectory, "auth.json"),
          modelsPath: operation === "discover" ? null : path.join(value.agentDir, "models.json"),
          refreshOnCreate: false,
          allowModelNetwork: false,
          signal: controller.signal,
        });
        const providers = models.getProviders().map((provider) => ({
          id: provider.id,
          methods: [
            ...(provider.auth.apiKey?.login ? ["api_key"] : []),
            ...(provider.auth.oauth?.login ? ["oauth"] : []),
          ],
        }));
        if (operation === "discover") {
          send({ type: "providers", providers });
        } else {
          if (typeof value.provider !== "string" || !providers.some((provider) => provider.id === value.provider))
            throw new Error("provider");
          if (operation === "logout") await models.logout(value.provider, { signal: controller.signal });
          else {
            if (value.method !== "api_key" && value.method !== "oauth") throw new Error("method");
            let sequence = 0;
            await models.login(value.provider, value.method, {
              signal: controller.signal,
              prompt: async (prompt) => {
                if (controller.signal.aborted || prompt.signal?.aborted) throw new Error("cancelled");
                if (answer) throw new Error("concurrent prompt");
                const id = ++sequence;
                const dismiss = (): void => {
                  if (answer?.id !== id) return;
                  const pending = answer;
                  answer = undefined;
                  send({ type: "dismiss", id });
                  pending.reject();
                };
                prompt.signal?.addEventListener("abort", dismiss, { once: true });
                try {
                  return await new Promise<string>((resolve, reject) => {
                    answer = { id, resolve, reject: () => reject(new Error("cancelled")) };
                    // Prompt labels are not echoed: providers may include sensitive values in prose.
                    send({
                      type: "prompt",
                      id,
                      kind: prompt.type,
                      ...(prompt.type === "select"
                        ? { options: prompt.options.map(({ id, label }) => ({ id, label })) }
                        : {}),
                    });
                  });
                } finally {
                  prompt.signal?.removeEventListener("abort", dismiss);
                  answer = undefined;
                }
              },
              notify: (event) => {
                if (event.type === "auth_url") send({ type: "url", url: event.url });
                else if (event.type === "device_code")
                  send({ type: "device", url: event.verificationUri, code: event.userCode });
                // Do not forward arbitrary provider messages, progress, links, or exceptions.
              },
            });
          }
          send({ type: "changed" });
        }
      } else if (operation === "export" || operation === "import") {
        if (typeof value.cwd !== "string" || typeof value.input !== "string" || typeof value.output !== "string")
          throw new Error("request");
        const cwd = value.cwd;
        const agentDir = process.env.PI_CODING_AGENT_DIR;
        if (!agentDir || !path.isAbsolute(cwd)) throw new Error("request");
        const createRuntime: CreateAgentSessionRuntimeFactory = async ({ sessionManager }) => {
          const services = await createAgentSessionServices({
            cwd,
            agentDir,
            settingsManager: SettingsManager.inMemory(),
            modelRuntime: await ModelRuntime.create({
              refreshOnCreate: false,
              allowModelNetwork: false,
              modelsPath: null,
              signal: controller.signal,
            }),
            resourceLoaderOptions: {
              noExtensions: true,
              noSkills: true,
              noPromptTemplates: true,
              noContextFiles: true,
              noThemes: true,
            },
          });
          return {
            ...(await createAgentSessionFromServices({ services, sessionManager, noTools: "all" })),
            services,
            diagnostics: [],
          };
        };
        const sessionManager =
          operation === "export"
            ? SessionManager.inMemory(cwd, undefined, parseSessionEntries(readFileSync(value.input, "utf8")))
            : SessionManager.create(cwd, path.join(agentDir, "imports"));
        const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });
        try {
          if (operation === "export") {
            if (value.leaf === null) sessionManager.resetLeaf();
            else if (typeof value.leaf === "string" && sessionManager.getEntry(value.leaf))
              sessionManager.branch(value.leaf);
            else throw new Error("leaf");
            runtime.session.exportToJsonl(value.output);
          } else {
            const result = await runtime.importFromJsonl(value.input);
            if (result.cancelled) throw new Error("cancelled");
            // Preserve the complete imported tree; do not turn an import into a branch export.
            const { copyFileSync, constants } = await import("node:fs");
            if (!runtime.session.sessionFile) throw new Error("missing import");
            copyFileSync(runtime.session.sessionFile, value.output, constants.COPYFILE_EXCL);
          }
          send({ type: "complete" });
        } finally {
          await runtime.dispose();
        }
      } else throw new Error("operation");
    } catch (error) {
      send({
        type: "failure",
        category:
          error instanceof CredentialSynchronizationError
            ? "changed-refresh-failed"
            : controller.signal.aborted
              ? "cancelled"
              : "failed",
      });
    } finally {
      clearTimeout(timer);
      cancel();
      process.stdin.removeListener("data", receive);
      process.stdin.removeListener("end", cancel);
      input = Buffer.alloc(0);
      ctx.shutdown();
    }
  });
}
