import { EditorState, type Extension } from "@codemirror/state";
import { search, SearchQuery, setSearchQuery } from "@codemirror/search";

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
