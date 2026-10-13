import { createApp } from "vue";
import { createPinia } from "pinia";
import { router } from "./router.js";
import AppShell from "./components/AppShell.js";
import { installLineWrap } from "./line-wrap.js";
const app = createApp(AppShell);
app.use(createPinia());
app.use(router);
router.isReady().then(() => app.mount("#app"));
// 自动换行：代码块是 innerHTML 注入的，拿不到组件内的事件绑定，所以开关靠这里装一次文档级委托
// + 观察 DOM 变动补行号（详见 web/line-wrap.js）。挂载前装也可以：委托只靠选择器命中。
installLineWrap();
