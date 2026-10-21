---
"narumi-pi": patch
---

Show temporary Pi passage explanations in read-only native comments below code, while retaining whole-line highlights and hovers. Use the API's collapsed default and add `pi.annotations.initialState` in Pi Settings → Editor to choose collapsed or expanded for new or replaced annotations. Keep existing thread state and shared VS Code Comments settings unchanged. Group threads at range end lines and label them Pi annotation with Pi as author. Explanations also appear in the native Comments panel. VS Code may open that panel and change editor layout or visible range/scroll; comments visibility settings may hide widgets. Keep existing authorization, stale-content checks, limits, result semantics and clearing rules, including thread disposal.
