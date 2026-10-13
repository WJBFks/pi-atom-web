# 思考级别仪表图标（设计源图）

用户提供的一整套 reasoning gauge SVG（原始目录 `reasoning_gauge_svg_set_v3`，2026-09-25 入库）。
这里放的是**设计源图**，只是留档与对照用：页面运行时**不请求这些文件**，实际图标由
`web/icons.js` 的 `thinkingIcon(level)` 用同一套坐标参数化生成。

| 源图 | 级别 | 点亮段（7 段里第几段，0 起） | 指针末端坐标 |
| --- | --- | --- | --- |
| `01-off.svg` | `off` | 0 | (39.53, 70.59) |
| `02-minimum.svg` | `minimum` / `minimal` | 1 | (45.47, 62.36) |
| `03-low.svg` | `low` | 2 | (54.03, 56.91) |
| `04-medium.svg` | `medium` | 3 | (64.00, 55.00) |
| `05-high.svg` | `high` | 4 | (73.97, 56.91) |
| `06-xhigh.svg` | `xhigh` | 5 | (82.53, 62.36) |
| `07-max.svg` | `max` | 6 | (88.47, 70.59) |

共同的几何：7 段刻度（`rect` 11×7、`rx` 3.5，各自 `rotate(角度 cx cy)`）、一根指针（`line` 从轴心
(64, 82) 到上表的末端坐标、`stroke-width` 6.5、`stroke-linecap` round）与轴心（`circle` r 7.5），
画布 128×128。

## 与运行时版本的差异（改图标时注意）

1. **颜色**：源图写死 `#20242A`（点亮段/指针/轴心）与 `#C8CDD3`（未点亮段）。运行版改成点亮段与
   指针/轴心 `currentColor`、未点亮段同色 28% 透明度（`web/style.css` 的 `.gauge-icon`），这样浅色/
   深色主题与「未选中灰 / 选中深色」都自动跟随按钮文字色，不需要为两套主题各出一版。
2. **viewBox**：源图是整块 128×128 画布；运行版裁到内容外框 `16 31 96 61`，配合 CSS 的 19×12 槽位
   刚好铺满（按 128 缩放会糊成一团）。
3. 因此**改了这里的源图不会自动生效**，要同步改 `web/icons.js` 里的 `GAUGE_TICKS` / `GAUGE_LEVELS`
   （两者必须一一对得上，`reasoning-levels-preview.svg` 可以整排预览比对）。
