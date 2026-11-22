import mermaid from "mermaid";

// Rendering is driven only by the renderer's validated queue, even before window load.
mermaid.startOnLoad = false;
Object.assign(window, { piMermaid: mermaid });
