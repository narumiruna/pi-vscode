// Public Pi 1.3.0 JSON/RPC shapes. No provider, credentials, or Pi runtime dependency.
const content = [
  {
    type: "thinking",
    thinking: "Authoritative visible thinking.",
    thinkingSignature: "THINKING_SIGNATURE_MUST_NOT_LEAK",
  },
  { type: "text", text: "Fixture answer." },
  {
    type: "thinking",
    redacted: true,
    thinking: "REDACTED_TEXT_MUST_NOT_LEAK",
    thinkingSignature: "ENCRYPTED_SIGNATURE_MUST_NOT_LEAK",
  },
  { type: "thinking", thinking: "Second visible block. <img src=x onerror=alert(1)>" },
];
const updates = [
  { type: "thinking_start", contentIndex: 0 },
  { type: "thinking_delta", contentIndex: 0, delta: "Partial thinking." },
  { type: "thinking_start", contentIndex: 3 },
  { type: "thinking_delta", contentIndex: 3, delta: "Second partial." },
  { type: "text_start", contentIndex: 1 },
  { type: "text_delta", contentIndex: 1, delta: "Partial answer." },
  { type: "thinking_end", contentIndex: 0, content: content[0].thinking },
  { type: "thinking_end", contentIndex: 3, content: content[3].thinking },
  { type: "text_end", contentIndex: 1, content: content[1].text },
];
module.exports = { content, updates };
