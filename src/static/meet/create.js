import { createEvent } from "./api.js";
import { dayLabel } from "./slots.js";
import { el } from "./grid.js";

const DEFAULT_DAYS = 5;

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function timeLabel(minute) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function timeSelect(id, value, minutes) {
  const select = el("select", { id });
  for (const m of minutes) select.append(el("option", { value: String(m), textContent: timeLabel(m) }));
  select.value = String(value);
  return select;
}

export function mountCreate(root) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const title = el("input", { id: "meet-title", type: "text", maxLength: 100 });
  const dateInput = el("input", { id: "meet-date", type: "date" });
  const addDate = el("button", { id: "meet-add-date", type: "button" }, "Add date");
  const dates = el("ul", { id: "meet-dates" });
  const halfHours = Array.from({ length: 49 }, (_, i) => i * 30);
  const from = timeSelect("meet-from", 540, halfHours);
  const to = timeSelect("meet-to", 1020, halfHours);
  const tz = el("span", { id: "meet-tz", textContent: timezone });
  const submit = el("button", { id: "meet-create", type: "submit" }, "Create event");
  const error = el("p", { id: "meet-error" });
  error.setAttribute("role", "alert");
  const chosen = new Set();

  function renderDates() {
    dates.replaceChildren(
      ...[...chosen].sort().map((date) => {
        const remove = el("button", { type: "button", className: "meet-remove-date", textContent: "Remove" });
        remove.setAttribute("aria-label", `Remove ${dayLabel(date)}`);
        remove.addEventListener("click", () => {
          chosen.delete(date);
          renderDates();
        });
        const li = el("li", {}, el("span", { textContent: dayLabel(date) }), " ", remove);
        li.dataset.date = date;
        return li;
      }),
    );
  }

  const today = new Date();
  for (let i = 0; i < DEFAULT_DAYS; i++) chosen.add(isoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + i)));
  renderDates();

  addDate.addEventListener("click", () => {
    if (!dateInput.value) return;
    chosen.add(dateInput.value);
    renderDates();
  });

  const form = el(
    "form",
    { id: "meet-form", noValidate: true },
    el("label", {}, "Title ", title),
    el("div", { className: "meet-dates-field" }, el("label", {}, "Date ", dateInput), " ", addDate, dates),
    el("div", { className: "meet-times" }, el("label", {}, "From ", from), el("label", {}, "To ", to)),
    el("p", {}, "Timezone: ", tz),
    submit,
    error,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    submit.disabled = true;
    try {
      const event = await createEvent({
        title: title.value,
        dates: [...chosen].sort(),
        startMinute: Number(from.value),
        endMinute: Number(to.value),
        timezone,
      });
      location.assign(`/meet?id=${event.id}`);
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = false;
    }
  });
  root.append(form);
}
