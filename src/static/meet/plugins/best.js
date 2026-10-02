import { bestBlocks, rangeLabel } from "../slots.js";

const CSS_URL = new URL("./best.css", import.meta.url).href;
const LIMIT = 3;

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

export function mount(ctx) {
  const stylesheet = el("link", { rel: "stylesheet", href: CSS_URL });
  document.head.append(stylesheet);

  const list = el("ol", { className: "meet-best-list" });
  const empty = el("p", { className: "meet-best-empty", textContent: "No common time yet" });
  const overlays = el("div", { className: "meet-best-overlays" });
  const panel = el("div", { id: "meet-best" }, el("h4", {}, "Best times"), list, empty, overlays);
  const wrapper = el("div", { className: "meet-tool" }, panel);
  wrapper.dataset.plugin = "best";
  ctx.side.append(wrapper);

  let highlighted = null;

  // Overlays sit in the wrapper, positioned over the bounding boxes of the heatmap cells of a block.
  function clearHighlight() {
    highlighted = null;
    overlays.replaceChildren();
  }

  function drawHighlight() {
    overlays.replaceChildren();
    if (!highlighted) return;
    const origin = wrapper.getBoundingClientRect();
    for (let i = highlighted.from; i <= highlighted.to; i++) {
      const cell = ctx.root.querySelector(`#meet-group-grid .meet-cell[data-slot="${i}"]`);
      if (!cell) continue;
      const box = cell.getBoundingClientRect();
      const overlay = el("div", { className: "meet-best-highlight" });
      overlay.style.left = `${box.left - origin.left}px`;
      overlay.style.top = `${box.top - origin.top}px`;
      overlay.style.width = `${box.width}px`;
      overlay.style.height = `${box.height}px`;
      overlays.append(overlay);
    }
  }

  function highlight(block) {
    highlighted = block;
    drawHighlight();
  }

  function render(event) {
    clearHighlight();
    const blocks = bestBlocks(event, LIMIT);
    empty.hidden = blocks.length > 0;
    list.hidden = blocks.length === 0;
    list.replaceChildren(
      ...blocks.map((block) => {
        const item = el(
          "li",
          { className: "meet-best-item", tabIndex: 0 },
          el("strong", { className: "meet-best-range", textContent: rangeLabel(event, block.from, block.to) }),
          el("span", { className: "meet-best-count", textContent: `${block.count} of ${event.participants.length} free` }),
          el("span", {
            className: "meet-best-missing",
            textContent: block.busy.length ? `Missing: ${block.busy.join(", ")}` : "Everyone can make it",
          }),
        );
        item.addEventListener("pointerenter", () => highlight(block));
        item.addEventListener("pointerleave", clearHighlight);
        item.addEventListener("focus", () => highlight(block));
        item.addEventListener("blur", clearHighlight);
        return item;
      }),
    );
  }

  render(ctx.getEvent());
  const unsubscribe = ctx.onChange(render);
  window.addEventListener("resize", drawHighlight);

  return () => {
    unsubscribe();
    window.removeEventListener("resize", drawHighlight);
    wrapper.remove();
    stylesheet.remove();
  };
}
