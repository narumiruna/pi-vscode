# Pi Coding Agent for VS Code

在 VS Code Activity Bar 的專屬對話視窗使用 Pi，也能直接詢問或修改編輯器中選取的程式碼。
介面以 Copilot 的 Chat view、Chat participant、inline chat 與 smart actions 為參考。

## Features

- Activity Bar 提供專屬 **Pi > Chat** 對話視窗。
- 對話視窗支援多輪問答、取消要求、清除對話，以及明確附加目前選取的程式碼。
- 對話紀錄會有限量地保存在目前 workspace，隱藏或重新開啟 view 後仍會保留。
- 從 Command Palette 執行 **Pi: Open Chat** 可直接開啟專屬對話視窗。
- 仍可在 VS Code 原生 Chat view 使用 `@pi`，並使用 `/explain`、`/review` 或 `/fix`。
- Native Chat request 會附帶有限長度的對話歷史，以及使用者加入的檔案或選取範圍 references。
- 在編輯器選取程式碼後，從右鍵選單開啟 **Pi**。
- **Ask About Selection** 會詢問問題，並在側邊開啟 Markdown 回覆。
- **Modify Selection** 會要求 Pi 產生替代程式碼並套用到原本選取範圍。
- 文件在等待期間若有變更，擴充功能不會套用過期的修改。
- 可設定 Pi 執行檔、provider、model 與 thinking level。
- 支援取消執行中的要求。

Prompt、對話內容與程式碼只會透過 subprocess stdin 傳給 Pi，不會放進 command-line arguments。
每個動作都使用 `--no-session --no-tools`，因此不會建立 Pi session，也不允許代理程式自行執行工具。
連續對話由擴充功能將有限長度的對話 history 加入下一個 prompt。

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
2. 在 **Chat** view 輸入訊息並按 Enter 或 **Send**。
3. 若要加入程式碼，先在編輯器選取內容，再按 **Attach selection**。
4. 使用 **Cancel** 停止目前要求，或使用 **New chat** 清除 workspace 對話紀錄。

### Native Chat Participant

1. 開啟 VS Code 原生 Chat view。
2. 輸入 `@pi` 後提出問題。
3. 使用 Chat 的 **Add Context** 加入檔案或選取範圍。
4. 視需要使用 `/explain`、`/review` 或 `/fix`。

### Selection Actions

1. 在編輯器中選取一段程式碼。
2. 按右鍵並選擇 **Pi > Ask About Selection** 或 **Pi > Modify Selection**。
3. 輸入問題或修改指示。
4. 修改後可使用 VS Code 的 Undo 復原。

也可以從 Command Palette 執行 `Pi: Ask About Selection` 與 `Pi: Modify Selection`。

## Settings

| Setting | Default | Description |
| --- | --- | --- |
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

目前版本提供專屬 conversation view、原生 Chat participant 與選取程式碼 actions。
對話訊息會保存在 workspace state，但每次要求仍是獨立的 Pi subprocess。
持久 Pi session、token streaming、Markdown rich rendering、工具執行審核、程式碼自動完成與背景 agent session 尚未包含。

## License

MIT
