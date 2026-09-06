// Pre-process Obsidian-flavored markdown for react-markdown rendering:
// - ![[embed]] → chip placeholder
// - [[wikilink]] → styled span (no navigation in v1)
export function preprocessObsidianMd(src: string): string {
  const embed = src.replace(/!\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
    return `\`[임베드] ${inner}\``;
  });
  return embed.replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, (_m, target: string, alias?: string) => {
    const label = (alias ? alias.slice(1) : target).trim();
    return `\`[[${label}]]\``;
  });
}

export function extractSection(markdown: string, heading: string): string {
  // returns body of `### heading` (or `## heading`) until next heading of same-or-higher level
  const lines = markdown.split("\n");
  let out: string[] = [];
  let level = 0;
  let collecting = false;
  for (const line of lines) {
    const m = /^(#{2,6})\s+(.*)$/.exec(line);
    if (m) {
      if (collecting && m[1].length <= level) break;
      if (!collecting && m[2].trim() === heading.trim()) {
        collecting = true;
        level = m[1].length;
        continue;
      }
    }
    if (collecting) out.push(line);
  }
  return out.join("\n").trim();
}
