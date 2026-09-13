import { createApp } from "vue";
import { createPinia } from "pinia";
import { router } from "./router.js";
import AppShell from "./components/AppShell.js";
const app = createApp(AppShell);
app.use(createPinia());
app.use(router);
router.isReady().then(() => app.mount("#app"));
