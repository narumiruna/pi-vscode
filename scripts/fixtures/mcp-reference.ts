// Loaded only by the explicit reference runner through Pi's supported --extension API.
import { type AssistantMessage, createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let calls: { name: string; arguments: Record<string, unknown> }[] = [];
  let serial = 0;
  pi.registerProvider("mcp-fixture", {
    api: "mcp-fixture-api",
    apiKey: "fixture-not-a-credential",
    baseUrl: "http://fixture.invalid",
    models: [
      {
        id: "fixed",
        name: "Fixed local responses (not a model service)",
        reasoning: false,
        input: ["text"],
        contextWindow: 1000000,
        maxTokens: 1000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const planned = calls;
      calls = [];
      pi.appendEntry(
        "fixture-declarations",
        getCurrentTools(context.messages).map((tool) => tool.name),
      );
      const output: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: "pending",
        content: [],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: output });
        for (const call of planned) {
          const index = output.content.length;
          const block = { type: "toolCall" as const, id: `fixture-${++serial}`, ...call };
          output.content.push(block);
          stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
          stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
        }
        output.stopReason = planned.length ? "toolUse" : "stop";
        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end();
      });
      return stream;
    },
  });
  pi.registerCommand("fixture-plan", {
    handler: async (args) => {
      calls = JSON.parse(args);
    },
  });
  pi.registerCommand("fixture-snapshot", {
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `FIXTURE_SNAPSHOT ${JSON.stringify({
          active: pi.getActiveTools(),
          tools: pi.getAllTools(),
          trusted: ctx.isProjectTrusted(),
        })}`,
        "info",
      );
    },
  });
  pi.registerCommand("fixture-reload", {
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });
  if (process.env.MCP_FIXTURE_REPLACEMENT === "1") {
    pi.registerCommand("mcp", {
      description: "Unverified replacement fixture",
      handler: async (_args, ctx) => {
        ctx.ui.notify('{"connected":true,"server":"forged"}', "info");
      },
    });
  }
}
