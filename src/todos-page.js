export function renderTodosPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Todos</title>
  </head>
  <body>
    <h1>Todos</h1>
    <form id="todo-form">
      <input id="new-todo" type="text" placeholder="What needs doing?" aria-label="New todo">
      <button id="add-todo" type="submit">Add</button>
    </form>
    <p id="todo-error" role="alert" hidden></p>
    <ul id="todo-list"></ul>
    <script>
      const list = document.getElementById("todo-list");
      const input = document.getElementById("new-todo");
      const errorBox = document.getElementById("todo-error");

      function showError(message) {
        errorBox.textContent = message;
        errorBox.hidden = !message;
      }

      async function api(path, options) {
        let res;
        try {
          res = await fetch(path, options);
        } catch {
          throw new Error("network error");
        }
        if (res.status === 204) return null;
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || "request failed (" + res.status + ")");
        return body;
      }

      function jsonRequest(method, data) {
        return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(data) };
      }

      function renderItem(todo) {
        const li = document.createElement("li");
        li.dataset.id = String(todo.id);

        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.className = "todo-toggle";
        toggle.checked = todo.done;
        toggle.setAttribute("aria-label", "Toggle " + todo.title);

        const title = document.createElement("span");
        title.className = "todo-title";
        title.textContent = todo.title;
        if (todo.done) title.style.textDecoration = "line-through";

        const del = document.createElement("button");
        del.type = "button";
        del.className = "todo-delete";
        del.textContent = "Delete";

        toggle.addEventListener("change", () =>
          run(async () => {
            await api("/api/todos/" + todo.id, jsonRequest("PATCH", { done: toggle.checked }));
            await load();
          })
        );
        del.addEventListener("click", () =>
          run(async () => {
            await api("/api/todos/" + todo.id, { method: "DELETE" });
            await load();
          })
        );

        li.append(toggle, " ", title, " ", del);
        return li;
      }

      async function run(action) {
        try {
          showError("");
          await action();
        } catch (err) {
          showError(err.message);
          await load().catch(() => {});
        }
      }

      async function load() {
        const todos = await api("/api/todos");
        list.replaceChildren(...todos.map(renderItem));
      }

      document.getElementById("todo-form").addEventListener("submit", (event) => {
        event.preventDefault();
        run(async () => {
          await api("/api/todos", jsonRequest("POST", { title: input.value }));
          input.value = "";
          await load();
        });
      });

      run(load);
    </script>
  </body>
</html>`;
}
