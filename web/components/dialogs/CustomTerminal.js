import {
  defineComponent,
  h,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { postAction } from "../../api/actions.js";

let xtermPromise;
const loadAsset = (tag, url) =>
  new Promise((resolve, reject) => {
    const attribute = tag === "link" ? "href" : "src";
    const existing = document.querySelector(`${tag}[${attribute}="${url}"]`);
    const element = existing || document.createElement(tag);
    if (tag === "link") element.rel = "stylesheet";
    element[attribute] = url;
    element.addEventListener("load", resolve, { once: true });
    element.addEventListener("error", () => reject(new Error(`无法加载 ${url}`)), {
      once: true,
    });
    if (!existing) document.head.append(element);
  });
const loadXterm = () => {
  if (globalThis.Terminal) return Promise.resolve(globalThis.Terminal);
  xtermPromise ||= Promise.all([
    loadAsset("link", "/xterm.css"),
    loadAsset("script", "/xterm.js"),
  ])
    .then(() => {
      if (!globalThis.Terminal) throw new Error("xterm 加载完成但未提供 Terminal");
      return globalThis.Terminal;
    })
    .catch((error) => {
      xtermPromise = undefined;
      throw error;
    });
  return xtermPromise;
};

export const sanitizeLine = (line) =>
  String(line)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, (code) =>
      /^\x1b\[[0-9;:]*m$/.test(code) ? code : "",
    )
    .replace(/\x1b(?!\[)[^]?/g, "")
    .replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, "");

export function createTerminalSender({
  requestId,
  sessionId,
  post,
  onError = () => {},
}) {
  let disposed = false;
  const controller = new AbortController();
  let queue = Promise.resolve();
  const send = (value) => {
    if (disposed || typeof value !== "string") return;
    queue = queue
      .catch(() => {})
      .then(async () => {
        for (
          let offset = 0;
          !disposed && offset < value.length;
          offset += 4096
        ) {
          await post(
            {
              type: "dialog_response",
              id: requestId,
              sessionId,
              value: value.slice(offset, offset + 4096),
            },
            controller.signal,
          );
        }
      })
      .catch((error) => {
        if (!disposed && error.name !== "AbortError") onError(error);
      });
  };
  return {
    send,
    dispose() {
      disposed = true;
      controller.abort();
    },
    done: () => queue,
  };
}

export default defineComponent({
  name: "CustomTerminal",
  props: {
    request: { type: Object, required: true },
    token: String,
    onError: Function,
  },
  setup(props) {
    const host = ref(),
      screen = ref();
    const requestId = props.request.id;
    const requestSessionId = props.request.sessionId;
    const sender = createTerminalSender({
      requestId,
      sessionId: requestSessionId,
      post: (action, signal) =>
        postAction(props.token, action, undefined, signal),
      onError: props.onError,
    });
    let terminal,
      observer,
      disposeInput,
      output = "";
    const fit = () => {
      const element = screen.value;
      const xtermScreen = element?.querySelector(".xterm-screen");
      if (!element || !xtermScreen?.offsetWidth || !host.value?.clientWidth)
        return;
      const scale = Math.min(
        1,
        host.value.clientWidth / xtermScreen.offsetWidth,
      );
      element.style.transform = `scale(${scale})`;
      host.value.style.height = `${xtermScreen.offsetHeight * scale}px`;
    };
    const repaint = () => {
      if (!terminal) return;
      const lines = props.request.lines || [];
      const next = lines.map(sanitizeLine).join("\r\n");
      terminal.resize(
        Math.max(1, Math.min(1000, props.request.columns || 120)),
        Math.max(1, lines.length),
      );
      if (next !== output) {
        output = next;
        terminal.write(`\x1b[0m\x1b[2J\x1b[H${next}`);
      }
      requestAnimationFrame(fit);
    };
    let disposed = false;
    onMounted(async () => {
      let TerminalClass;
      try {
        TerminalClass = await loadXterm();
      } catch (error) {
        if (!disposed) props.onError?.(error);
        return;
      }
      if (disposed) return;
      terminal = new TerminalClass({
        cols: 80,
        rows: 1,
        scrollback: 0,
        convertEol: true,
        fontSize: 14,
        fontFamily:
          '"Noto Sans Mono", "JetBrains Mono", "Fira Code", "Consolas", ui-monospace, "Microsoft YaHei", monospace',
        allowProposedApi: false,
        disableStdin: false,
        theme: {
          background: "#252a33",
          foreground: "#d8dee9",
          cursor: "#88c0d0",
        },
      });
      terminal.open(screen.value);
      disposeInput = terminal.onData(sender.send);
      observer = new ResizeObserver(fit);
      observer.observe(host.value);
      repaint();
    });
    watch(() => [props.request.lines, props.request.columns], repaint, {
      deep: true,
    });
    onBeforeUnmount(() => {
      disposed = true;
      sender.dispose();
      observer?.disconnect();
      disposeInput?.dispose();
      terminal?.dispose();
    });
    return () =>
      h(
        "div",
        {
          class: "terminal-host",
          ref: host,
          "aria-label": "可交互扩展终端",
          onClick: () => terminal?.focus(),
        },
        [h("div", { class: "terminal-screen", ref: screen })],
      );
  },
});
