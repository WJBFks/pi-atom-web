import { defineComponent, h } from "vue";
import { icon } from "../../icons.js";

/**
 * 输入卡左下角加号（`#attach-button`）展开的添加菜单（用户 2026-09-25 选定：四项、不要分组标题）。
 *
 * 只有「添加图片」是动作，另外三项**插入命令草稿 + 聚焦**，发送仍由用户按下 —— 菜单不该替他发。
 * 定位与 `#command-menu` 同一条通道：`#composer{position:relative}` + `bottom:calc(100% + 8px)`，
 * 所以它永远浮在整张输入卡上方，窄屏也只要改 left/right。
 *
 * 图标都是现成的：`terminal` 是命令行、`spark` 是技能（设置页「定义 → 技能」同款）、
 * `box` 是压缩块；只有加号 `plus` 是新增的。
 */
const ITEMS = [
  { key: "image", icon: "image", label: "添加图片", desc: "从本地选择，可多选" },
  { key: "commands", icon: "terminal", label: "斜杠命令", desc: "插入 / 后从命令列表选" },
  { key: "skills", icon: "spark", label: "附加技能", desc: "插入 /skill: 后选技能" },
  { key: "compact", icon: "box", label: "压缩上下文", desc: "插入 /compact，发送后执行" },
];

export default defineComponent({
  name: "AttachMenu",
  props: {
    // 与原图片按钮一致：发送中不能改附件。
    imagesDisabled: { type: Boolean, default: false },
    pick: { type: Function, required: true },
  },
  setup(props) {
    return () =>
      h(
        "div",
        {
          class: "attach-menu",
          id: "attach-menu",
          role: "menu",
          "aria-label": "添加",
        },
        ITEMS.map((item) =>
          h(
            "button",
            {
              key: item.key,
              type: "button",
              role: "menuitem",
              class: "attach-item",
              "data-attach": item.key,
              disabled: item.key === "image" && props.imagesDisabled,
              onClick: () => props.pick(item.key),
            },
            [
              h("span", { class: "attach-icon" }, icon(item.icon)),
              h("span", { class: "attach-label" }, item.label),
              h("span", { class: "attach-desc" }, item.desc),
            ],
          ),
        ),
      );
  },
});
