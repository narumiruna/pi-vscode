const commands = [
  { name: "new", description: "Start a new Pi session" },
  { name: "model", description: "Choose the current session model" },
  { name: "thinking", description: "Choose the model thinking level" },
  { name: "settings", description: "Open Pi Configuration without starting Pi" },
  { name: "extension-settings", description: "Open native VS Code extension settings" },
  { name: "skills", description: "Discover and insert a loaded Pi skill" },
  { name: "commands", description: "Discover and insert a Pi command, prompt template, or skill" },
  { name: "resume", description: "Search saved sessions in this workspace" },
  { name: "session", description: "Show conversation details and context usage" },
  { name: "reconnect", description: "Connect to Pi and refresh conversation history" },
  { name: "compact", description: "Manually compact the session context; accepts optional instructions" },
  { name: "reload", description: "Reload approved Pi resources without a model request" },
] as const;

export const sidebarSlashCommands = commands.map((command) => ({ ...command, source: "sidebar" as const }));

export function parseSidebarSlashCommand(
  text: string,
): { readonly name: (typeof commands)[number]["name"]; readonly arguments: string } | undefined {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const command = commands.find((candidate) => candidate.name === match?.[1]);
  return command ? { name: command.name, arguments: match?.[2]?.trim() ?? "" } : undefined;
}

export function discoverSlashCommands(commands: readonly Record<string, unknown>[], skillsOnly = false) {
  const names = new Set(sidebarSlashCommands.map((command) => command.name as string));
  return commands.flatMap((command) => {
    if (
      typeof command.name !== "string" ||
      command.name.length > 200 ||
      !/^[^\s/]+$/.test(command.name) ||
      /^vscode-pi-/i.test(command.name) ||
      names.has(command.name) ||
      (skillsOnly && command.source !== "skill")
    )
      return [];
    names.add(command.name);
    return [
      {
        name: command.name,
        description: typeof command.description === "string" ? command.description.slice(0, 1_000) : undefined,
        source: typeof command.source === "string" ? command.source : undefined,
      },
    ];
  });
}
