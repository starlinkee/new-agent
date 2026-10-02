import { mountCreate } from "./create.js";
import { mountView } from "./view.js";

const root = document.getElementById("meet-root");
const id = new URLSearchParams(location.search).get("id");
if (id === null) mountCreate(root);
else mountView(root, id);
