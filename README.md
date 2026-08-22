# Pi Coding Agent for VS Code

在 VS Code Activity Bar 的專屬對話視窗使用 Pi，也能直接詢問或修改編輯器中選取的程式碼。
介面以 Copilot 的 Chat view、Chat participant、inline chat 與 smart actions 為參考。

## Features

- Activity Bar 提供專屬 **Pi > Chat** 對話視窗。
- 對話視窗透過持久 Pi RPC session 串流回覆、思考狀態、重試、壓縮與工具活動。
- 支援 Ask、Edit、Plan 與 Agent 模式，並為每個模式設定明確的工具權限。
- 支援取消要求、新建／命名／恢復 session、context compaction，以及在終端機接續目前 session。
- 可直接選擇 Pi model 與 thinking level。
- 可附加目前選取內容、目前檔案、Problems diagnostics、selected terminal output、PNG/JPEG/GIF/WebP images，或從檔案選擇器加入多個 bounded context items。
- 可手動觸發或選擇啟用 cancellable、debounced、cached inline ghost-text completions。
- 提供 Inline Edit、Explain、Fix、Review、Document 與 Generate Tests editor actions。
- 所有 focused generated edits 都先在 VS Code diff view 預覽，只有明確選擇 **Apply Edit** 才會套用。
- `Pi: Suggest Next Edit` 會根據 cursor、current file 與 diagnostics 預測一個 focused whole-file change，並開啟 diff preview。
- Foreground Agent/Edit mode 會追蹤 Pi edit/write tool 的檔案，並提供 Diff、Open、stale-safe Revert 與 Source Control actions。
- 可同時執行多個 independent background Agent tasks，查看串流狀態、取消，並恢復完成後的 Pi session。
- Background task 可選擇從目前 `HEAD` 建立 detached Git worktree 隔離執行，完成後可開啟或移除 worktree；尚未 commit 的目前 workspace 變更不會複製過去。
- Plan mode 可使用 **Implement Plan** 保留同一個 session context 並切換到 Agent mode。
- **Commands…** 會列出 Pi discovered extension commands、prompt templates 與 skills，並插入對應 slash command。
- Pi session 可 export 成 HTML、在 terminal 接續，或從 background/worktree task 恢復。
- 可從 Pi session 恢復有限長度的對話紀錄。
- 從 Command Palette 執行 **Pi: Open Chat** 可直接開啟專屬對話視窗。
- 仍可在 VS Code 原生 Chat view 使用 `@pi`，並使用 `/explain`、`/review` 或 `/fix`。
- Native Chat request 會附帶有限長度的對話歷史，以及使用者加入的檔案或選取範圍 references。
- 在編輯器選取程式碼後，從右鍵選單開啟 **Pi**。
- **Ask About Selection** 會詢問問題，並在側邊開啟 Markdown 回覆。
- **Modify Selection** 會要求 Pi 產生替代程式碼並套用到原本選取範圍。
- 文件在等待期間若有變更，擴充功能不會套用過期的修改。
- 可設定 Pi 執行檔、provider、model、thinking level 與 project resource trust。
- 支援取消執行中的要求與非預期 process exit recovery。

Prompt、對話內容與程式碼只會透過 subprocess stdin 傳給 Pi，不會放進 command-line arguments。
專屬 conversation view 使用 Pi 自己的持久 session、authentication、model registry、AGENTS.md、skills、prompt templates 與 extensions。
Ask 與 Plan 模式只允許 read、grep、find、ls。
Edit 模式可讀寫檔案但不能執行 shell command。
Agent 模式必須由使用者確認啟用，並允許 Pi 使用完整 coding tools。
Packaged Pi permission gate 可在 dangerous mutating tools 或每個 bash/edit/write call 執行前要求 VS Code modal approval。
原生 `@pi` 與 selection actions 仍使用隔離的 one-shot、no-tools request。

## Requirements

1. 安裝 [Pi coding agent](https://pi.dev)。
2. 在終端機執行 `pi`，並使用 `/login` 完成驗證，或設定 provider 所需的 API key。
3. 確認 `pi --version` 可在 VS Code extension host 的環境中執行。

如果 VS Code 找不到 `pi`，請把 `piCodingAgent.executablePath` 設成完整路徑。

## Installation

```bash
code --install-extension ./pi-coding-agent.vsix --force
```

更新既有安裝後，請執行 **Developer: Reload Window** 載入新版本。

## Quick Start

1. 在 terminal 執行 `pi`，使用 `/login` 或 API key 確認 Pi 可以正常回覆。
2. 安裝 VSIX 並執行 **Developer: Reload Window**。
3. 從 Activity Bar 開啟 **Pi**。
4. 先使用預設 Ask mode 測試問題，再視需要切換 Edit、Plan 或 Agent。
5. Agent mode、Background 與 Worktree 都會在取得明確確認後才啟用 mutating tools。

## Usage

### Pi Conversation View

1. 從 Activity Bar 選擇 **Pi**，或從 Command Palette 執行 **Pi: Open Chat**。
2. 從上方選擇 Ask、Edit、Plan 或 Agent mode。
3. 在 **Chat** view 輸入訊息並按 Enter 或 **Send**。
4. 若要加入程式碼，先在編輯器選取內容，再按 **Attach selection**。
5. 使用 **Cancel** 停止目前要求。
6. 使用 **New**、**Resume**、**Name**、**Compact**、**Export** 與 **Terminal** 管理 Pi session。
7. 使用 **Commands…** 選擇 Pi command、prompt template 或 skill。
8. 使用 **Background** 平行執行 Agent，或使用 **Worktree** 在 isolated detached worktree 執行。
9. Agent/Edit 完成後，可從 **Pi changes** review diff、open 或安全 revert captured files。

### Native Chat Participant

1. 開啟 VS Code 原生 Chat view。
2. 輸入 `@pi` 後提出問題。
3. 使用 Chat 的 **Add Context** 加入檔案或選取範圍。
4. 視需要使用 `/explain`、`/review` 或 `/fix`。

### Editor Actions

1. 在編輯器中選取一段程式碼。
2. 按右鍵並從 **Pi** 選擇 Ask、Modify、Explain、Fix、Review、Document 或 Generate Tests。
3. Inline Edit 可使用 `Ctrl+Alt+I`，macOS 使用 `Cmd+Alt+I`。
4. 修改會先開啟 diff preview；選擇 **Apply Edit** 才會套用，之後仍可使用 Undo。

### Inline Completions

- 使用 `Alt+]` 手動觸發一次 Pi ghost-text completion。
- 使用 `Ctrl+Alt+N`，macOS 使用 `Cmd+Alt+N`，預覽 Pi predicted next edit。
- 將 `piCodingAgent.inlineCompletions.enabled` 設成 `true` 可在停止輸入後自動要求 completion。
- 新的編輯會取消舊 request；短時間內相同 context 會使用 bounded cache。

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `piCodingAgent.inlineCompletions.enabled` | `false` | 是否在 typing pause 後自動要求 inline completion；manual trigger 不受影響。 |
| `piCodingAgent.inlineCompletions.debounceMilliseconds` | `650` | Automatic completion debounce。 |
| `piCodingAgent.inlineCompletions.minimumPrefixLength` | `3` | Automatic request 所需的 current-line prefix 長度。 |
| `piCodingAgent.inlineCompletions.excludedLanguages` | `plaintext`, `scminput` | 不要求 completion 的 language IDs。 |
| `piCodingAgent.agent.confirmToolCalls` | `dangerous` | Per-tool policy：`off`、`dangerous` 或 `all`。 |
| `piCodingAgent.defaultMode` | `ask` | 新 conversation runtime 的預設 Ask、Edit、Plan 或 Agent mode。 |
| `piCodingAgent.approveProjectResources` | `false` | 是否信任並載入 project-local Pi settings、extensions、skills 與 prompts。 |
| `piCodingAgent.executablePath` | `pi` | Pi CLI 的命令或完整路徑。 |
| `piCodingAgent.provider` | empty | 選用的 provider override。 |
| `piCodingAgent.model` | empty | 選用的 model override。 |
| `piCodingAgent.thinkingLevel` | `default` | 選用的 thinking-level override。 |

空白的 override 會沿用 Pi 自己的設定。

## Pi Customization

- Pi 會依照自己的規則載入 global authentication、models、settings、AGENTS.md、extensions、skills 與 prompt templates。
- Project-local Pi resources 預設不會由 extension 自動信任。
- 只有在確認 workspace 可信任後，才將 `piCodingAgent.approveProjectResources` 設成 `true`。
- 啟用後，Pi RPC process 會使用 `--approve` 載入 project-local `.pi` resources。
- MCP 並非 Pi core 內建功能；若已安裝提供 MCP tools 的 Pi extension，Agent mode 會照常載入並使用它。
- **Commands…** 的內容直接來自 Pi RPC `get_commands`，因此會反映目前可用的 extension commands、prompts 與 skills。

## Context and Privacy

- Text context 每個 item 上限 200,000 characters，合計上限 400,000 characters，最多 8 個 items。
- Image context 最多 5 張，每張上限 5 MiB。
- Terminal context 只會在使用者按 **Terminal text** 時複製目前選取內容。
- Prompt、context 與 image payload 都透過 Pi process stdin 傳送，不會放進 command-line arguments。

## Troubleshooting

- **Pi icon does not appear:** Confirm `narumitw.pi-coding-agent` is installed, then run **Developer: Reload Window**.
- **Disconnected:** Run `pi --version` in the same VS Code environment and set `piCodingAgent.executablePath` to the full executable path when needed.
- **No model or authentication error:** Run `pi`, complete `/login`, and verify the model works in the workspace terminal.
- **Project skills or prompts missing:** Trust the workspace first, then enable `piCodingAgent.approveProjectResources` and start a new Pi session.
- **No automatic completion:** Automatic requests are opt-in; enable `piCodingAgent.inlineCompletions.enabled` or use `Alt+]` manually.
- **Tool stays blocked:** Review the permission dialog and `piCodingAgent.agent.confirmToolCalls`; gated tools fail closed when no permission UI is available.
- **Worktree misses current edits:** Worktrees start from committed `HEAD`; commit intended changes before launching an isolated task.
- **Changes made by shell are not revertible:** Review them through Source Control and use Git recovery instead of checkpoint revert.

## Development

```bash
npm install
npm test
npm run package
```

按 `F5` 可在 Extension Development Host 中手動測試 Pi conversation view、`@pi` 與右鍵選單。
`npm install` 會設定 Husky，pre-commit hook 會執行 `npm test`。
`npm run package` 會建立 `pi-coding-agent.vsix`。

## Current Scope

目前版本提供持久 streaming Pi runtime、四種操作模式、session/model controls、Pi customization discovery、text/image/terminal context、session export、專屬 conversation view、原生 Chat participant、inline completions、focused editor actions、change checkpoints，以及平行 background/worktree agents。
Checkpoint revert 僅涵蓋 Pi edit/write tools 明確觸及且小於 2 MiB 的 workspace files。
Shell commands 造成的額外變更仍會顯示在 VS Code Source Control，但不會自動建立可 revert checkpoint。
Assistant responses support safe headings, lists, emphasis, inline code, and fenced code blocks.
Vendor-hosted cloud execution and cross-machine synchronization require the corresponding external service; local background/worktree agents, Git/`gh`, session export, and terminal handoff provide the local workflow.

## License

MIT
