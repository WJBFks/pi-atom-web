import { inject, provide } from "vue";

/**
 * 级联折叠（用户 2026-09-24）：手动折叠父级时，其下的中间过程组与中间过程卡片一并收起。
 *
 * - 父级（轮次分组 / 中间过程组）在**手动折叠**那一刻调用 `conversation.markCollapsed(blockKey)`
 *   占一个全局序号；子级计算自己的开合时，只要任一祖先的折叠序号大于自己最后一次开合的序号，
 *   就一律收起。
 * - 因此级联是单向的：父级再展开时**不恢复**子级此前的展开状态（用户选定「不恢复，保持收起」）；
 *   子级在此之后被用户手动展开，会刷新自己的时间戳，于是又能展开。
 * - 两份序号都只在内存里，不落盘：刷新后一切回到默认（轮次收起、组收起、卡片收起）。
 *
 * 祖先链用 provide/inject 传，而不是 `cascadeParents` 一路透传：卡片埋在
 * `MessageItem → ThinkingBlock / ToolCallBlock → DisclosureBlock` 里，中间几层组件
 * 根本不关心折叠，加 prop 会把改动面摊到五六个文件。
 */
const CASCADE_KEY = Symbol("disclosure-cascade");

/** 父级组件在 setup 里调用：把祖先链加上自己这一层，提供给内部所有折叠块。 */
export function provideCascade(blockKey) {
  const outer = inject(CASCADE_KEY, []);
  const chain = blockKey ? [...outer, String(blockKey)] : outer;
  provide(CASCADE_KEY, chain);
  return chain;
}

/** 折叠块（或自己算开合的组件）在 setup 里调用：取祖先 blockKey 列表。 */
export function useCascade() {
  return inject(CASCADE_KEY, []);
}
