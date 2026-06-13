// Shared inline markup transforms for story entry content, applied at render
// time (never baked into story_entry.content):
//  - [[break]]            -> story's Scene Break Divider text (or left literal if unset)
//  - [[text|translation]] -> hover-tooltip translation

const TOOLTIP_RE = /\[\[([^[\]\n|]*)\|([^[\]\n]*)\]\]/g;

function replaceTooltips(line, target) {
  return line.replace(TOOLTIP_RE, (_, text, translation) => {
    text = text.trim();
    translation = translation.trim();
    return target === 'html'
      ? `<span class="tooltip">${text}<span class="tooltiptext">${translation}</span></span>`
      : `${text} *(${translation})*`;
  });
}

// export.js uses this to decide whether a line should become <p class="scene-break">
export function isSceneBreakLine(line, dividerText) {
  return !!dividerText && line.trim().toLowerCase() === '[[break]]';
}

// target: 'discord' -> content is the full multi-line entry; handles [[break]]
//   line-swap AND [[text|translation]] tooltips, returns the transformed string.
// target: 'html' -> content is a SINGLE line (export.js already handled [[break]]
//   for this line before calling this); handles only [[text|translation]].
export function applyEntryMarkup(content, { dividerText = null, target = 'discord' } = {}) {
  if (target === 'html') return replaceTooltips(content, 'html');

  return content.split('\n').map(line => {
    if (line.trim().toLowerCase() === '[[break]]') return dividerText ?? line;
    return replaceTooltips(line, 'discord');
  }).join('\n');
}
