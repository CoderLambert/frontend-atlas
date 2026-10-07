export function splitTrailingUnclosedFence(markdown) {
  const lines = markdown.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  let offset = 0;
  let open = null;

  for (const line of lines) {
    const sourceLine = line.replace(/\r?\n$/u, "");
    if (!open) {
      const start = sourceLine.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
      if (start && !(start[1][0] === "`" && start[2].includes("`"))) {
        open = { offset, marker: start[1][0], length: start[1].length };
      }
    } else {
      const close = new RegExp(`^ {0,3}${open.marker}{${open.length},}[\\t ]*$`, "u");
      if (close.test(sourceLine)) open = null;
    }
    offset += line.length;
  }

  if (!open) return { body: markdown, unfinishedCode: null };

  const unfinishedFence = markdown.slice(open.offset);
  const firstLineBreak = unfinishedFence.match(/\r?\n/u)?.[0];
  return {
    body: markdown.slice(0, open.offset),
    unfinishedCode: firstLineBreak ? unfinishedFence.slice(unfinishedFence.indexOf(firstLineBreak) + firstLineBreak.length) : "",
  };
}
