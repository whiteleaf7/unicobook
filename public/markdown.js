// Gemini が書いたあらすじの Markdown を、見出し・箇条書き・段落だけの簡単な HTML にする。
// 中身は textContent で入れるので、HTML として解釈されることはない

export function renderMarkdown(md) {
  const container = document.createElement('div');
  container.className = 'summary-content';
  const append = (tag, text, parent = container) => {
    const el = document.createElement(tag);
    el.textContent = text;
    parent.append(el);
  };
  // 続けて箇条書きの行が来たら、同じ <ul> に足す
  let currentList = null;

  for (const line of md.split('\n').map((l) => l.trim())) {
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const item = line.match(/^[-*•]\s+(.*)$/);
    if (item) {
      if (!currentList) {
        currentList = document.createElement('ul');
        container.append(currentList);
      }
      append('li', item[1], currentList);
      continue;
    }
    currentList = null;
    // シートの見出し（h2）より下にするため、一段下げる
    if (heading) append(`h${Math.min(heading[1].length + 1, 4)}`, heading[2]);
    else if (line) append('p', line);
  }
  return container;
}
