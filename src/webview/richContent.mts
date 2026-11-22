import DOMPurify from "dompurify";
import { completedFenceBoundary, completedFenceClass } from "./markdownBoundary";

type Mermaid = typeof import("mermaid").default;
const globals = window as Window & { piMermaid?: Mermaid };
const bootstrapScript = document.currentScript as HTMLScriptElement | null;
const mermaidScript = bootstrapScript?.dataset.mermaidScript;
const nonce = bootstrapScript?.nonce;
let mermaidLoad: Promise<Mermaid | undefined> | undefined;

function loadMermaid(): Promise<Mermaid | undefined> {
  // The URL and nonce come from the host's bootstrap tag, never from transcript content.
  // Keep the first result, including failure, so streaming updates cannot trigger retries.
  mermaidLoad ??= new Promise<Mermaid | undefined>((resolve) => {
    if (!mermaidScript || !nonce) return resolve(undefined);
    const script = document.createElement("script");
    script.nonce = nonce;
    script.src = mermaidScript;
    const finish = (mermaid?: Mermaid) => {
      delete globals.piMermaid;
      script.remove();
      resolve(mermaid);
    };
    script.onload = () => finish(globals.piMermaid);
    script.onerror = () => finish();
    document.head.append(script);
  }).catch(() => undefined);
  return mermaidLoad;
}

const maxSource = 8000;
const maxCache = 64;
const maxCacheCharacters = 2_000_000;
const pending = new Map<HTMLElement, Job>();
const cache = new Map<string, { svg: string } | null>();
let cacheCharacters = 0;
let sequence = 0;
let running = false;
let disposed = false;
let activeTheme = theme();
let configuredTheme: typeof activeTheme | undefined;
interface Job {
  element: HTMLElement;
  source: string;
  key: string;
  resize: () => void;
}

function theme(): "dark" | "default" {
  return document.body.classList.contains("vscode-dark") || document.body.classList.contains("vscode-high-contrast")
    ? "dark"
    : "default";
}
function configure(mermaid: Mermaid): void {
  if (configuredTheme === activeTheme) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: activeTheme,
    maxTextSize: maxSource,
    maxEdges: 100,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    sequence: { useMaxWidth: true },
  });
  configuredTheme = activeTheme;
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
  job.element.removeAttribute("aria-label");
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
      const mermaid = await loadMermaid();
      if (!current(job)) continue;
      const renderTheme = activeTheme;
      let value: { svg: string } | null = null;
      try {
        if (mermaid) {
          configure(mermaid);
          const result = await mermaid.render(`piDiagram${++sequence}`, job.source);
          if (disposed) break;
          const svg = cleanSvg(result.svg);
          if (svg.includes("<svg")) value = { svg };
        }
      } catch {
        /* Keep the source on load, parser, layout or sanitizer failure. */
      }
      if (disposed) break;
      if (renderTheme === activeTheme) {
        store(job.key, value);
        display(job, value);
      }
    }
  } finally {
    running = false;
  }
}
function enrich(element: HTMLElement | DocumentFragment, resize: () => void): void {
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
  if (pending.size && !running) queueMicrotask(() => void drain());
}
interface Boundary {
  end: number;
  node: HTMLElement;
}
const boundaries = new WeakMap<HTMLElement, Boundary>();

function readBoundary(fragment: DocumentFragment, html: string, offset: number): Boundary | undefined {
  const last = html.lastIndexOf(completedFenceBoundary);
  if (last === -1) return undefined;
  let node: HTMLElement | undefined;
  for (const marker of fragment.querySelectorAll(`.${completedFenceClass}`)) {
    const prev = marker.previousSibling;
    node =
      marker.parentNode === fragment &&
      prev instanceof HTMLElement &&
      (prev.tagName === "PRE" || prev.classList.contains("mermaid-source"))
        ? prev
        : undefined;
    marker.remove();
  }
  if (node) return { node, end: offset + last + completedFenceBoundary.length };
}

function setContent(element: HTMLElement, html: string, resize: () => void, previousHtml?: string): void {
  const prior = boundaries.get(element);
  // The caller passes previous HTML only for the same assistant tail. The host has fully rendered
  // the new source, so even later link definitions that change earlier blocks break this match.
  const retained =
    prior?.node.parentNode === element &&
    previousHtml &&
    previousHtml.length >= prior.end &&
    html.startsWith(previousHtml.slice(0, prior.end))
      ? prior
      : undefined;
  const offset = retained?.end ?? 0;
  const suffix = html.slice(offset);
  const fragment = DOMPurify.sanitize(suffix, {
    USE_PROFILES: { html: true, mathMl: true },
    ADD_TAGS: ["semantics", "annotation"],
    ADD_ATTR: ["encoding"],
    FORBID_TAGS: ["style", "img", "input", "form", "iframe", "object", "embed"],
    ALLOW_DATA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  const next = readBoundary(fragment, suffix, offset) ?? retained;
  if (next) boundaries.set(element, next);
  else boundaries.delete(element);
  if (retained) while (retained.node.nextSibling) retained.node.nextSibling.remove();
  for (const target of pending.keys()) {
    if (!target.isConnected || (!retained && element.contains(target))) pending.delete(target);
  }
  enrich(fragment, resize);
  if (retained) element.append(fragment);
  else element.replaceChildren(fragment);
}
function dispose(): void {
  disposed = true;
  pending.clear();
  cache.clear();
  cacheCharacters = 0;
  observer.disconnect();
}
const observer = new MutationObserver(() => {
  if (theme() === activeTheme || disposed) return;
  activeTheme = theme();
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
