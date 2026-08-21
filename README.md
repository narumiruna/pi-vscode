# Pi Coding Agent for VS Code

在 VS Code Activity Bar 的專屬對話視窗使用 Pi，也能直接詢問或修改編輯器中選取的程式碼。
介面以 Copilot 的 Chat view、Chat participant、inline chat 與 smart actions 為參考。

## Features

- Activity Bar 提供專屬 **Pi > Chat** 對話視窗。
- 對話視窗透過持久 Pi RPC session 串流回覆、思考狀態、重試、壓縮與工具活動。
- 支援 Ask、Edit、Plan 與 Agent 模式，並為每個模式設定明確的工具權限。
- 支援取消要求、新建／命名／恢復 session、context compaction，以及在終端機接續目前 session。
- 可直接選擇 Pi model 與 thinking level。
- 可附加目前選取內容、目前檔案、Problems diagnostics，或從檔案選擇器加入多個 bounded context items。
- 可手動觸發或選擇啟用 cancellable、debounced、cached inline ghost-text completions。
- 提供 Inline Edit、Explain、Fix、Review、Document 與 Generate Tests editor actions。
- 所有 focused generated edits 都先在 VS Code diff view 預覽，只有明確選擇 **Apply Edit** 才會套用。
- Foreground Agent/Edit mode 會追蹤 Pi edit/write tool 的檔案，並提供 Diff、Open、stale-safe Revert 與 Source Control actions。
- 可同時執行多個 independent background Agent tasks，查看串流狀態、取消，並恢復完成後的 Pi session。
- Background task 可選擇從目前 `HEAD` 建立 detached Git worktree 隔離執行，完成後可開啟或移除 worktree；尚未 commit 的目前 workspace 變更不會複製過去。
- Plan mode 可使用 **Implement Plan** 保留同一個 session context 並切換到 Agent mode。
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

## Usage

### Pi Conversation View

1. 從 Activity Bar 選擇 **Pi**，或從 Command Palette 執行 **Pi: Open Chat**。
2. 從上方選擇 Ask、Edit、Plan 或 Agent mode。
3. 在 **Chat** view 輸入訊息並按 Enter 或 **Send**。
4. 若要加入程式碼，先在編輯器選取內容，再按 **Attach selection**。
5. 使用 **Cancel** 停止目前要求。
6. 使用 **New**、**Resume**、**Name**、**Compact** 與 **Terminal** 管理 Pi session。
7. 使用 **Background** 平行執行 Agent，或使用 **Worktree** 在 isolated detached worktree 執行。
8. Agent/Edit 完成後，可從 **Pi changes** review diff、open 或安全 revert captured files。

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
- 將 `piCodingAgent.inlineCompletions.enabled` 設成 `true` 可在停止輸入後自動要求 completion。
- 新的編輯會取消舊 request；短時間內相同 context 會使用 bounded cache。

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `piCodingAgent.inlineCompletions.enabled` | `false` | 是否在 typing pause 後自動要求 inline completion；manual trigger 不受影響。 |
| `piCodingAgent.inlineCompletions.debounceMilliseconds` | `650` | Automatic completion debounce。 |
| `piCodingAgent.inlineCompletions.minimumPrefixLength` | `3` | Automatic request 所需的 current-line prefix 長度。 |
| `piCodingAgent.inlineCompletions.excludedLanguages` | `plaintext`, `scminput` | 不要求 completion 的 language IDs。 |
| `piCodingAgent.defaultMode` | `ask` | 新 conversation runtime 的預設 Ask、Edit、Plan 或 Agent mode。 |
| `piCodingAgent.approveProjectResources` | `false` | 是否信任並載入 project-local Pi settings、extensions、skills 與 prompts。 |
| `piCodingAgent.executablePath` | `pi` | Pi CLI 的命令或完整路徑。 |
| `piCodingAgent.provider` | empty | 選用的 provider override。 |
| `piCodingAgent.model` | empty | 選用的 model override。 |
| `piCodingAgent.thinkingLevel` | `default` | 選用的 thinking-level override。 |

空白的 override 會沿用 Pi 自己的設定。

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

目前版本提供持久 streaming Pi runtime、四種操作模式、session/model controls、專屬 conversation view、原生 Chat participant、inline completions、focused editor actions、change checkpoints，以及平行 background/worktree agents。
Checkpoint revert 僅涵蓋 Pi edit/write tools 明確觸及且小於 2 MiB 的 workspace files。
Shell commands 造成的額外變更仍會顯示在 VS Code Source Control，但不會自動建立可 revert checkpoint。
尚未包含 Markdown rich rendering、next-edit prediction、cloud-hosted agent service，以及跨機器 session synchronization。

## License

MIT
