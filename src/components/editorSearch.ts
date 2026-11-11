import { EditorState, type Extension } from "@codemirror/state";
import { search, SearchQuery, setSearchQuery } from "@codemirror/search";
import { EditorView } from "@codemirror/view";

// 使用内置词条接口，同时翻译可见控件和屏幕阅读器提示，不改写面板 DOM。
const searchPhrases = {
  "Find": "查找",
  "Replace": "替换",
  "next": "下一个",
  "previous": "上一个",
  "all": "选中全部",
  "match case": "区分大小写",
  "regexp": "正则表达式",
  "by word": "全字匹配",
  "replace": "替换",
  "replace all": "全部替换",
  "close": "关闭",
  "current match": "当前匹配",
  "replaced $ matches": "已替换 $ 处匹配",
  "replaced match on line $": "已替换第 $ 行的匹配",
  "on line": "所在行",
  "Go to line": "跳转到行",
  "go": "跳转",
};

export const editorSearch: Extension = [
  search({ literal: true }),
  EditorState.phrases.of(searchPhrases),
  // 控件固定 20px 高，输入列限制最大宽度；查找、替换仍分行并适配窄容器。
  EditorView.theme({
    ".cm-panels": {
      backgroundColor: "var(--bg-column)", color: "var(--text)", borderBottom: "1px solid var(--line)",
      containerType: "inline-size", containerName: "editor-search",
    },
    ".cm-panel.cm-search": {
      display: "grid", gridTemplateColumns: "minmax(0, 100px) repeat(6, max-content)",
      alignItems: "center", justifyContent: "start", gap: "clamp(2px, .2vw, 4px)",
      padding: "clamp(3px, .3vw, 5px) 28px clamp(3px, .3vw, 5px) clamp(3px, .3vw, 5px)",
      fontSize: "clamp(11px, .8vw, 12px)", lineHeight: "1.35",
    },
    ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label": { margin: "0" },
    ".cm-panel.cm-search .cm-textfield, .cm-panel.cm-search .cm-button": {
      background: "var(--bg-input)", color: "var(--text-input)", border: "1px solid var(--border-control)",
      borderRadius: "4px", font: "inherit", height: "20px", minHeight: "20px",
      lineHeight: "16px", boxSizing: "border-box",
    },
    ".cm-panel.cm-search .cm-textfield": {
      width: "100%", maxWidth: "100px", minWidth: "0", padding: "1px 6px",
    },
    // 按钮填满内容列，消除列内留白；查找和替换按钮之间的距离统一由 gap 控制。
    ".cm-panel.cm-search .cm-button": {
      gridRow: "1", justifySelf: "stretch", padding: "1px 6px", whiteSpace: "nowrap",
    },
    // 明确定位两行，不再依赖 br 在 Flex 布局中的换行行为。
    ".cm-panel.cm-search br": { display: "none" },
    ".cm-panel.cm-search input[name=search]": { gridRow: "1", gridColumn: "1" },
    ".cm-panel.cm-search input[name=replace]": { gridRow: "2", gridColumn: "1" },
    ".cm-panel.cm-search button[name=replace]": { gridRow: "2", gridColumn: "2" },
    ".cm-panel.cm-search button[name=replaceAll]": {
      gridRow: "2", gridColumn: "3 / span 2", justifySelf: "start",
    },
    ".cm-panel.cm-search label": {
      display: "inline-flex", flexDirection: "row", alignItems: "center", gap: "3px",
      gridRow: "1", justifySelf: "start", color: "var(--muted)", fontSize: "inherit", whiteSpace: "nowrap",
    },
    ".cm-panel.cm-search input[type=checkbox]": {
      width: "12px", height: "12px", padding: "0", borderRadius: "0", flexShrink: "0",
    },
    // 关闭按钮有独立空间，不被换行后的查找或替换控件遮挡。
    ".cm-panel.cm-search button[name=close]": {
      top: "3px", right: "3px", width: "20px", height: "20px", padding: "0", fontSize: "14px",
      color: "var(--text)", lineHeight: "1",
    },
    // 双栏等窄容器将搜索选项移到查找行下面；替换框和替换按钮仍保持同一独立行。
    "@container editor-search (max-width: 600px)": {
      ".cm-panel.cm-search": { gridTemplateColumns: "minmax(0, 100px) repeat(3, max-content)" },
      ".cm-panel.cm-search label": { gridRow: "2" },
      ".cm-panel.cm-search input[name=replace]": { gridRow: "3" },
      ".cm-panel.cm-search button[name=replace], .cm-panel.cm-search button[name=replaceAll]": { gridRow: "3" },
    },
    // 更窄时每个输入框独占一行，操作按钮紧跟其下，查找和替换区域不会交叉混排。
    "@container editor-search (max-width: 320px)": {
      ".cm-panel.cm-search": { gridTemplateColumns: "repeat(3, max-content)" },
      ".cm-panel.cm-search input[name=search]": { gridColumn: "1 / -1" },
      ".cm-panel.cm-search button[name=next], .cm-panel.cm-search button[name=prev], .cm-panel.cm-search button[name=select]": { gridRow: "2" },
      ".cm-panel.cm-search label": { gridRow: "3" },
      ".cm-panel.cm-search input[name=replace]": { gridRow: "4", gridColumn: "1 / -1" },
      ".cm-panel.cm-search button[name=replace]": { gridRow: "5", gridColumn: "1" },
      ".cm-panel.cm-search button[name=replaceAll]": { gridRow: "5", gridColumn: "2 / span 2" },
    },
  }),
  // 内置面板更新查询时会丢失 literal；在同一事务末尾补齐，避免路径被再次转义。
  // 只调整搜索状态，不修改正文；主动开启正则时沿用原生正则及替换转义规则。
  EditorState.transactionExtender.of((transaction) => {
    for (let index = transaction.effects.length - 1; index >= 0; index -= 1) {
      const effect = transaction.effects[index];
      if (!effect.is(setSearchQuery)) continue;
      const query = effect.value;
      const literal = !query.regexp;
      return query.literal === literal ? null : {
        effects: setSearchQuery.of(new SearchQuery({ ...query, literal })),
      };
    }
    return null;
  }),
];
