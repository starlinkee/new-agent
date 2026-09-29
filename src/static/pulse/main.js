import { mountDashboard } from "./dashboard.js";
import { mountLanding } from "./landing.js";

const root = document.getElementById("pulse-root");
const siteId = new URLSearchParams(location.search).get("site");
if (siteId) mountDashboard(root, siteId);
else mountLanding(root);
