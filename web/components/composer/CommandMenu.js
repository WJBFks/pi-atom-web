import { defineComponent, h } from "vue";

export default defineComponent({
  name: "CommandMenu",
  props: {
    matches: { type: Array, required: true },
    query: Boolean,
    index: Number,
    commands: Array,
    onComplete: Function,
  },
  setup(props) {
    const message = () =>
      !Array.isArray(props.commands)
        ? "当前连接的扩展未提供命令列表。请在 TUI 执行 /reload 后重新打开 /web。"
        : props.commands.length === 0
          ? "当前 pi 返回的命令列表为空，请在 TUI 执行 /reload 后重新打开 /web。"
          : "没有匹配命令；内置终端命令请在 TUI 中使用。";
    return () =>
      props.query
        ? h("div", { id: "command-menu" }, [
            h("div", { class: "command-heading" }, "斜杠命令"),
            h(
              "div",
              { id: "command-list", role: "listbox" },
              props.matches.length
                ? props.matches.map((item, index) =>
                    h(
                      "button",
                      {
                        key: item.name,
                        id: `command-${index}`,
                        type: "button",
                        role: "option",
                        "aria-selected": index === props.index,
                        onClick: () => props.onComplete?.(index),
                      },
                      [
                        h("strong", `/${item.name}`),
                        h("span", item.description || item.source),
                      ],
                    ),
                  )
                : h("p", { class: "muted" }, message()),
            ),
          ])
        : null;
  },
});
