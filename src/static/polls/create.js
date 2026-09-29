import { createPoll, listPolls } from "./api.js";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 8;
const DURATIONS = [
  ["No deadline", ""],
  ["1 min", 60],
  ["10 min", 600],
  ["1 hour", 3600],
  ["1 day", 86400],
];

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

export function mountCreate(root) {
  const question = el("input", { id: "poll-question", type: "text", maxLength: 200, required: false });
  const options = el("div", { id: "poll-options" });
  const addButton = el("button", { id: "poll-add-option", type: "button" }, "Add option");
  const duration = el(
    "select",
    { id: "poll-duration" },
    ...DURATIONS.map(([label, value]) => el("option", { value, textContent: label })),
  );
  const submit = el("button", { id: "poll-create", type: "submit" }, "Create poll");
  const error = el("p", { id: "poll-error" });
  error.setAttribute("role", "alert");
  const form = el(
    "form",
    { id: "poll-form", noValidate: true },
    el("label", {}, "Question ", question),
    options,
    addButton,
    el("label", {}, "Closes after ", duration),
    submit,
    error,
  );
  const list = el("ul", { id: "poll-list" });
  root.append(form, el("h2", {}, "Recent polls"), list);

  function optionInputs() {
    return [...options.querySelectorAll("input")];
  }

  function syncOptions() {
    const rows = [...options.children];
    rows.forEach((row, i) => {
      row.querySelector("input").setAttribute("aria-label", `Option ${i + 1}`);
      row.querySelector("button")?.setAttribute("aria-label", `Remove option ${i + 1}`);
    });
    addButton.disabled = rows.length >= MAX_OPTIONS;
  }

  function addOption() {
    const input = el("input", { type: "text", maxLength: 100, className: "poll-option-input" });
    const row = el("div", { className: "poll-option-row" }, input);
    if (options.children.length >= MIN_OPTIONS) {
      const remove = el("button", { type: "button", className: "poll-remove-option" }, "Remove");
      remove.addEventListener("click", () => {
        row.remove();
        syncOptions();
      });
      row.append(remove);
    }
    options.append(row);
    syncOptions();
  }

  for (let i = 0; i < MIN_OPTIONS; i++) addOption();
  addButton.addEventListener("click", addOption);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    const body = { question: question.value, options: optionInputs().map((input) => input.value) };
    if (duration.value !== "") body.durationSec = Number(duration.value);
    submit.disabled = true;
    try {
      const poll = await createPoll(body);
      location.assign(`/polls?id=${encodeURIComponent(poll.id)}`);
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = false;
    }
  });

  listPolls()
    .then((polls) => {
      list.replaceChildren(
        ...polls.map((poll) => {
          const link = el("a", { className: "poll-link", href: `/polls?id=${encodeURIComponent(poll.id)}` });
          link.append(el("span", { className: "poll-link-question", textContent: poll.question }));
          link.append(` (${poll.total} ${poll.total === 1 ? "vote" : "votes"})`);
          return el("li", {}, link);
        }),
      );
    })
    .catch((err) => {
      list.replaceChildren(el("li", {}, err.message));
    });
}
