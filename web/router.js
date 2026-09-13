import { createMemoryHistory, createRouter } from "vue-router";
import ChatView from "./views/ChatView.js";
export const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", redirect: "/chat" },
    { path: "/chat", component: ChatView },
    { path: "/:pathMatch(.*)*", redirect: "/chat" },
  ],
});
