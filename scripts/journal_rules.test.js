const assert = require("assert");
const fs = require("fs");
const {
  normalizeLogin,
  parseFrontmatter,
  validateMetadata,
  isArticleMarkdown,
  isTechnicalUser
} = require("./journal_rules");

const config = JSON.parse(fs.readFileSync(".journal/metadata.json", "utf8"));

function metadata(overrides = {}) {
  return {
    title: "测试稿件",
    author: "2501 作者",
    author_display: "作者",
    received_date: "2026-07-09",
    editor: "张哲源",
    editor_username: "SaviorZhang211",
    status: "待责编审阅",
    ...overrides
  };
}

function assertValid(filename, data) {
  assert.doesNotThrow(() => validateMetadata(config, filename, data));
}

function assertInvalid(filename, data, pattern) {
  assert.throws(() => validateMetadata(config, filename, data), pattern);
}

assert.strictEqual(normalizeLogin("@Mr-Drinking"), "mr-drinking");
assert.strictEqual(isTechnicalUser(config, "mr-drinking"), true);
assert.strictEqual(isTechnicalUser(config, "@HSRST2026"), true);
assert.strictEqual(isArticleMarkdown(config, "文章/人文社科（张哲源）/测试.md"), true);
assert.strictEqual(isArticleMarkdown(config, "README.md"), false);

assert.deepStrictEqual(
  parseFrontmatter(
    [
      "---",
      'title: "测试稿件"',
      'author: "2501 作者"',
      'author_display: "作者"',
      'received_date: "2026-07-09"',
      'editor: "张哲源"',
      'editor_username: "SaviorZhang211"',
      'status: "待责编审阅"',
      "---",
      "正文"
    ].join("\n"),
    "文章/人文社科（张哲源）/测试.md"
  ),
  metadata()
);

assertValid("文章/人文社科（张哲源）/测试.md", metadata());
assertValid(
  "文章/其他/测试.md",
  metadata({
    editor: "叶静轩",
    editor_username: "Mr-Eating"
  })
);
assertValid(
  "文章/正文之外（张哲源、李洛霄）/非见刊类/本期征稿说明.md",
  metadata({
    author: "《鄞年・思叙》编辑部",
    author_display: "《鄞年・思叙》编辑部",
    create_date: "2026-05-30",
    editor: "沈泽厚",
    editor_username: "Mr-Drinking",
    status: "已见刊",
    received_date: undefined
  })
);

assertInvalid(
  "文章/正文之外（张哲源、李洛霄）/前言.md",
  metadata({
    create_date: "2026-05-28",
    editor: "对应责编",
    editor_username: "对应责编的 GitHub 用户名",
    status: "未开始",
    received_date: undefined
  }),
  /editor_username 不能包含空格/
);

assertInvalid(
  "文章/正文之外（张哲源、李洛霄）/前言.md",
  metadata({
    create_date: "2026-05-28"
  }),
  /received_date 与 create_date 必须且只能填写其中一个/
);

assertInvalid(
  "文章/正文之外（张哲源、李洛霄）/前言.md",
  metadata({
    editor: "李洛霄",
    editor_username: "LiLuoxiao"
  }),
  /该目录下的文件必须使用 create_date/
);

assertInvalid(
  "文章/创意写作（李洛霄）/测试.md",
  metadata({
    editor: "张哲源",
    editor_username: "SaviorZhang211"
  }),
  /editor\/editor_username 与所在目录不一致/
);

assertInvalid(
  "文章/其他/测试.md",
  metadata({
    editor: "未登记责编",
    editor_username: "UnknownEditor"
  }),
  /editor\/editor_username 与所在目录不一致/
);

assertInvalid(
  "文章/人文社科（张哲源）/测试.md",
  metadata({
    received_date: "2026-02-30"
  }),
  /不是有效日期/
);

console.log("journal_rules tests passed.");
