import { getPoll, votePoll } from "./api.js";
import { mountPlugins } from "./plugins/index.js";

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const votesLabel = (total) => `${total} ${total === 1 ? "vote" : "votes"}`;

export async function mountView(root, id) {
  const questionText = el("h2", { id: "poll-question-text" });
  const tools = el("div", { id: "poll-tools" });
  const results = el("div", { id: "poll-results" });
  const status = el("p", { id: "poll-status" });
  status.setAttribute("role", "status");
  const view = el("div", { id: "poll-view" }, questionText, tools, results, status);
  root.append(view);

  let poll;
  const voteListeners = new Set();
  const changeListeners = new Set();
  const subscribe = (set) => (listener) => {
    set.add(listener);
    return () => set.delete(listener);
  };
  const notify = (set, arg) => {
    for (const listener of [...set]) {
      try {
        listener(arg);
      } catch (err) {
        console.error("polls listener failed", err);
      }
    }
  };

  function render(next, { silent = false } = {}) {
    poll = next;
    const closed = poll.closesAt !== null && Date.parse(poll.closesAt) <= Date.now();
    view.classList.toggle("closed", closed);
    questionText.textContent = poll.question;
    const buttons = poll.options.map((text, i) => {
      const count = poll.tallies[i] ?? 0;
      const percent = poll.total > 0 ? Math.round((count / poll.total) * 100) : 0;
      const bar = el("span", { className: "poll-bar" }, el("span", { className: "poll-bar-fill" }));
      bar.firstChild.style.width = `${percent}%`;
      const button = el(
        "button",
        { type: "button", className: "poll-option", disabled: closed },
        el("span", { className: "poll-option-text", textContent: text }),
        el("span", { className: "poll-count", textContent: String(count) }),
        el("span", { className: "poll-percent", textContent: `${percent}%` }),
        bar,
      );
      button.dataset.option = String(i);
      button.setAttribute("aria-pressed", String(poll.myVote === i));
      return button;
    });
    results.replaceChildren(...buttons, el("p", { id: "poll-total", textContent: votesLabel(poll.total) }));
    if (!silent) notify(changeListeners, poll);
  }

  async function vote(index) {
    try {
      const updated = await votePoll(id, index);
      status.textContent = "";
      render(updated);
      notify(voteListeners, { option: index, poll });
    } catch (err) {
      status.textContent = err.message;
    }
  }

  results.addEventListener("click", (event) => {
    const button = event.target.closest("button.poll-option");
    if (button && !button.disabled) vote(Number(button.dataset.option));
  });

  window.__polls = {
    get poll() {
      return poll;
    },
    render: (next) => render(next),
    vote,
  };

  try {
    render(await getPoll(id));
  } catch (err) {
    status.textContent = err.status === 404 ? "Poll not found" : err.message;
    return;
  }
  mountPlugins({
    root: view,
    toolbar: tools,
    getPoll: () => poll,
    setPoll: (next) => render(next),
    onVote: subscribe(voteListeners),
    onChange: subscribe(changeListeners),
  });
}
