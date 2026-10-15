import DOMPurify from "dompurify";
import mermaid from "mermaid";

const maxSource = 8000;
const maxCache = 64;
const maxCacheCharacters = 2_000_000;
const pending = new Map<HTMLElement, Job>();
const cache = new Map<string, { svg: string } | null>();
let cacheCharacters = 0;
let sequence = 0;
let running = false;
let disposed = false;
let activeTheme = "";
interface Job {
  element: HTMLElement;
  source: string;
  key: string;
  resize: () => void;
}

function theme(): string {
  return document.body.classList.contains("vscode-dark") || document.body.classList.contains("vscode-high-contrast")
    ? "dark"
    : "default";
}
function configure(): void {
  activeTheme = theme();
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: activeTheme as "dark" | "default",
    maxTextSize: maxSource,
    maxEdges: 100,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    sequence: { useMaxWidth: true },
  });
}

export function allowedDiagram(source: string): boolean {
  // No user CSS, configuration, HTML, images, links or callbacks enter Mermaid's temporary DOM.
  return (
    source.length <= maxSource &&
    source.split("\n").length <= 120 &&
    /^(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\b|^sequenceDiagram\b/.test(source.trim()) &&
    !/%%\{|^\s*---|\b(?:click|classDef|linkStyle|style)\b|[<>]|@\{|https?:|data:/im.test(
      source.replace(/[-=]+>+|<[-=]+/g, ""),
    )
  );
}

function cleanSvg(svg: string): string {
  const fragment = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["a", "image", "foreignObject", "animate", "set"],
    RETURN_DOM_FRAGMENT: true,
  });
  for (const element of fragment.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      if (
        (/href$/i.test(attribute.name) && !attribute.value.startsWith("#")) ||
        /url\(\s*['"]?(?!#)/i.test(attribute.value)
      )
        element.removeAttribute(attribute.name);
    }
    if (element.tagName.toLowerCase() === "style" && /@import|url\(\s*['"]?(?!#)/i.test(element.textContent ?? ""))
      element.remove();
  }
  const container = document.createElement("div");
  container.append(fragment);
  return container.innerHTML;
}
function store(key: string, value: { svg: string } | null): void {
  const cost = key.length + (value?.svg.length ?? 0);
  if (cost > maxCacheCharacters) return;
  while (cache.size >= maxCache || cacheCharacters + cost > maxCacheCharacters) {
    const first = cache.keys().next().value;
    if (first === undefined) break;
    cacheCharacters -= first.length + (cache.get(first)?.svg.length ?? 0);
    cache.delete(first);
  }
  cache.set(key, value);
  cacheCharacters += cost;
}
function namespaceSvg(container: HTMLElement, prefix: string): void {
  const ids = new Map<string, string>();
  for (const element of container.querySelectorAll("[id]")) {
    const replacement = `${prefix}-${ids.size}`;
    ids.set(element.id, replacement);
    element.id = replacement;
  }
  const fragmentUrls = (value: string): string =>
    value.replace(/url\(\s*(["']?)#([^\s"')]+)\1\s*\)/gi, (original, quote: string, id: string) => {
      const replacement = ids.get(id);
      return replacement ? `url(${quote}#${replacement}${quote})` : original;
    });
  const rewriteRules = (rules: CSSRuleList): void => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        rule.selectorText = rule.selectorText.replace(/#[\w-]+/g, (selector) => {
          const replacement = ids.get(selector.slice(1));
          return replacement ? `#${replacement}` : selector;
        });
        for (const property of rule.style) {
          const value = rule.style.getPropertyValue(property);
          const rewritten = fragmentUrls(value);
          if (value !== rewritten)
            rule.style.setProperty(property, rewritten, rule.style.getPropertyPriority(property));
        }
      }
      if ("cssRules" in rule) rewriteRules((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const element of container.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      if (attribute.localName === "href" && attribute.value.startsWith("#")) {
        const replacement = ids.get(attribute.value.slice(1));
        if (replacement) attribute.value = `#${replacement}`;
      } else if (attribute.name === "aria-labelledby" || attribute.name === "aria-describedby") {
        attribute.value = attribute.value
          .split(/\s+/)
          .map((id) => ids.get(id) ?? id)
          .join(" ");
      } else if (attribute.name !== "id") attribute.value = fragmentUrls(attribute.value);
    }
    if (element.tagName.toLowerCase() === "style") {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(element.textContent ?? "");
      rewriteRules(sheet.cssRules);
      element.textContent = [...sheet.cssRules].map((rule) => rule.cssText).join("\n");
    }
  }
}
function current(job: Job): boolean {
  return !disposed && job.element.isConnected && job.element.dataset.diagramKey === job.key;
}
function display(job: Job, value: { svg: string } | null): void {
  if (!current(job)) return;
  const old = job.element.querySelector(".mermaid-preview");
  old?.remove();
  if (!value) {
    job.element.setAttribute("aria-label", "Diagram not rendered; source follows");
    return;
  }
  const preview = document.createElement("div");
  preview.className = "mermaid-preview";
  preview.setAttribute("role", "img");
  preview.setAttribute("aria-label", "Mermaid diagram; source follows");
  const unique = `piDiagram${++sequence}`;
  preview.innerHTML = value.svg;
  namespaceSvg(preview, unique);
  job.element.prepend(preview);
  job.resize();
}
async function drain(): Promise<void> {
  if (running || disposed) return;
  running = true;
  try {
    while (pending.size && !disposed) {
      const entry = pending.entries().next().value;
      if (!entry) break;
      const [element, job] = entry;
      pending.delete(element);
      if (!current(job)) continue;
      if (cache.has(job.key)) {
        display(job, cache.get(job.key) ?? null);
        continue;
      }
      const id = `piDiagram${++sequence}`;
      let value: { svg: string } | null = null;
      try {
        const result = await mermaid.render(id, job.source);
        const svg = cleanSvg(result.svg);
        if (svg.includes("<svg")) value = { svg };
      } catch {
        /* Keep the source on parser, layout or sanitizer failure. */
      }
      if (disposed) break;
      store(job.key, value);
      display(job, value);
    }
  } finally {
    running = false;
  }
}
function enrich(element: HTMLElement, resize: () => void): void {
  for (const target of element.querySelectorAll<HTMLElement>(".mermaid-source")) {
    const source = target.querySelector("code")?.textContent ?? "";
    const key = `${activeTheme}:${source}`;
    target.dataset.diagramKey = key;
    if (!allowedDiagram(source)) {
      target.setAttribute("aria-label", "Diagram not rendered; source follows");
      continue;
    }
    const job = { element: target, source, key, resize };
    if (pending.size < 100) pending.set(target, job);
    else target.setAttribute("aria-label", "Diagram not rendered; source follows");
  }
  // Initial content can be enriched before its article is attached.
  queueMicrotask(() => {
    void drain();
  });
}
function setContent(element: HTMLElement, html: string, resize: () => void): void {
  for (const target of pending.keys()) if (!target.isConnected || element.contains(target)) pending.delete(target);
  element.innerHTML = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, mathMl: true },
    ADD_TAGS: ["semantics", "annotation"],
    ADD_ATTR: ["encoding"],
    FORBID_TAGS: ["style", "img", "input", "form", "iframe", "object", "embed"],
    ALLOW_DATA_ATTR: false,
  });
  enrich(element, resize);
}
function dispose(): void {
  disposed = true;
  pending.clear();
  cache.clear();
  cacheCharacters = 0;
  observer.disconnect();
}
configure();
const observer = new MutationObserver(() => {
  if (theme() === activeTheme || disposed) return;
  configure();
  cache.clear();
  cacheCharacters = 0;
  pending.clear();
  for (const content of document.querySelectorAll<HTMLElement>(".content")) {
    enrich(content, () => document.dispatchEvent(new Event("pi-rich-resize")));
  }
});
observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
window.addEventListener("pagehide", dispose, { once: true });
Object.assign(window, { piRichContent: { setContent, dispose } });
