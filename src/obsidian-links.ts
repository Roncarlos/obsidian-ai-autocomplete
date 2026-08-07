import { App, parseLinktext, resolveSubpath, TFile } from "obsidian";

export interface LinkContextLimits {
  maxLinks: number;
  maxCharsPerLink: number;
  maxTotalChars: number;
}

type LinkScope = "note" | "section" | "block";

interface TruncatedContent {
  text: string;
  truncated: boolean;
}

export const DEFAULT_LINK_CONTEXT_LIMITS: LinkContextLimits = {
  maxLinks: 8,
  maxCharsPerLink: 3000,
  maxTotalChars: 10000,
};

const CONTEXT_OPEN = "<obsidian_references>";
const CONTEXT_CLOSE = "</obsidian_references>";

function removeAlias(linktext: string): string {
  for (let index = 0; index < linktext.length; index += 1) {
    if (linktext[index] === "|" && linktext[index - 1] !== "\\") {
      return linktext.slice(0, index).trim();
    }
  }
  return linktext.trim();
}

function isWebLink(linktext: string): boolean {
  return /^(?:https?:\/\/|mailto:|www\.)/i.test(linktext.trim());
}

function getLinkScope(subpath: string): LinkScope {
  if (!subpath) return "note";
  return subpath.startsWith("#^") ? "block" : "section";
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function extractInternalLinktexts(text: string): string[] {
  const linktexts: string[] = [];
  const wikilinkPattern = /!?\[\[([^\]\r\n]+)\]\]/g;
  let match: RegExpExecArray | null;

  while ((match = wikilinkPattern.exec(text)) !== null) {
    const linktext = removeAlias(match[1]);
    if (linktext && !isWebLink(linktext)) {
      linktexts.push(linktext);
    }
  }

  return linktexts;
}

function truncateContent(
  content: string,
  maxChars: number
): TruncatedContent {
  if (maxChars <= 0) return { text: "", truncated: content.length > 0 };
  if (content.length <= maxChars) {
    return { text: content, truncated: false };
  }
  if (maxChars === 1) return { text: "…", truncated: true };
  return {
    text: `${content
      .slice(0, maxChars - 1)
      .replace(/\s+$/, "")}…`,
    truncated: true,
  };
}

function getSubpathContent(
  app: App,
  file: TFile,
  subpath: string,
  content: string
): string | null {
  if (!subpath) return content;

  const cache = app.metadataCache.getFileCache(file);
  if (!cache) return null;

  const resolved = resolveSubpath(cache, subpath);
  if (!resolved) return null;

  const start = Math.max(0, resolved.start.offset);
  const end = Math.min(content.length, resolved.end?.offset ?? content.length);
  return content.slice(start, end);
}

export async function buildObsidianLinkContext(
  app: App,
  sourceFile: TFile,
  surroundingText: string,
  limits: LinkContextLimits = DEFAULT_LINK_CONTEXT_LIMITS
): Promise<string> {
  const entries: string[] = [];
  const visited = new Set<string>();
  let usedChars = CONTEXT_OPEN.length + CONTEXT_CLOSE.length + 2;

  for (const linktext of extractInternalLinktexts(surroundingText)) {
    if (entries.length >= limits.maxLinks || usedChars >= limits.maxTotalChars) {
      break;
    }

    const { path, subpath } = parseLinktext(linktext);
    if (isWebLink(path)) continue;

    const file = path
      ? app.metadataCache.getFirstLinkpathDest(path, sourceFile.path)
      : sourceFile;
    if (!file || file.extension.toLowerCase() !== "md") continue;

    const referenceKey = `${file.path.toLowerCase()}#${subpath.toLowerCase()}`;
    if (visited.has(referenceKey)) continue;
    visited.add(referenceKey);

    const fileContent = await app.vault.cachedRead(file);
    const selectedContent = getSubpathContent(
      app,
      file,
      subpath,
      fileContent
    )?.trim();
    if (!selectedContent) continue;

    const scope = getLinkScope(subpath);
    const target = escapeXml(`[[${linktext}]]`);
    const source = escapeXml(file.path);
    const headerStart =
      `<reference target="${target}" scope="${scope}" source="${source}"`;
    const fixedOverhead =
      headerStart.length +
      ' truncated="false">\n<content>\n\n</content>\n</reference>'.length;
    const separatorLength = entries.length > 0 ? 2 : 0;
    const remainingChars =
      limits.maxTotalChars - usedChars - separatorLength - fixedOverhead;
    if (remainingChars <= 0) break;

    const excerpt = truncateContent(
      escapeXml(selectedContent),
      Math.min(limits.maxCharsPerLink, remainingChars)
    );
    const entry =
      `${headerStart} truncated="${excerpt.truncated}">\n` +
      `<content>\n${excerpt.text}\n</content>\n</reference>`;
    entries.push(entry);
    usedChars += separatorLength + entry.length;
  }

  if (entries.length === 0) return "";

  return `${CONTEXT_OPEN}\n${entries.join("\n\n")}\n${CONTEXT_CLOSE}`;
}
