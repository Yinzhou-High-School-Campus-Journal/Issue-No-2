const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  normalizeLogin,
  parseFrontmatter,
  validateMetadata,
  isArticleMarkdown,
  isTechnicalUser
} = require("./journal_rules");

const config = JSON.parse(fs.readFileSync(".journal/metadata.json", "utf8"));

function metadata(overrides = {}) {
  const result = {
    title: "测试稿件",
    author: "2501 作者",
    author_display: "作者",
    received_date: "2026-07-09",
    editor: "张哲源",
    editor_username: "SaviorZhang211",
    status: "待责编审阅",
    ...overrides
  };

  for (const [field, value] of Object.entries(result)) {
    if (value === undefined) {
      delete result[field];
    }
  }

  return result;
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

assert.deepStrictEqual(
  parseFrontmatter(
    "\uFEFF---\r\ntitle: \"支持 BOM 和 CRLF\"\r\n---\r\n正文",
    "测试.md"
  ),
  { title: "支持 BOM 和 CRLF" }
);

assert.throws(
  () => parseFrontmatter('---\ntitle: "未闭合\n---\n正文', "测试.md"),
  /YAML 元数据语法错误/
);

assert.throws(
  () => parseFrontmatter("---\ntitle: 测试\n---oops\n正文", "测试.md"),
  /元数据块缺少结束的 ---/
);

assert.throws(
  () => parseFrontmatter("---\ntitle: 一\ntitle: 二\n---\n正文", "测试.md"),
  /YAML 元数据语法错误/
);

assert.throws(
  () => parseFrontmatter("---\ntitle:\n  - 一\n---\n正文", "测试.md"),
  /字段 title 的值必须是字符串/
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

assertInvalid(
  "文章/人文社科（张哲源）/测试.md",
  metadata({ status: "未开始" }),
  /status 与 received_date 不匹配/
);

assertInvalid(
  "文章/人文社科（张哲源）/测试.md",
  metadata({
    create_date: "2026-07-09",
    received_date: undefined,
    status: "待责编审阅"
  }),
  /status 与 create_date 不匹配/
);

assertValid(
  "文章/人文社科（张哲源）/测试.md",
  metadata({
    create_date: "2026-07-09",
    received_date: undefined,
    status: "写作中"
  })
);

assertInvalid(
  "文章/人文社科（张哲源）/测试.md",
  metadata({ extra: "不允许" }),
  /不允许的元数据字段：extra/
);

const repositoryRoot = path.resolve(__dirname, "..");
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "journal-metadata-"));
const validFixture = "文章/人文社科（张哲源）/有效稿件.md";
const legacyFixture = "文章/正文之外（张哲源、李洛霄）/历史占位稿.md";

fs.mkdirSync(path.join(fixtureRoot, path.dirname(validFixture)), { recursive: true });
fs.mkdirSync(path.join(fixtureRoot, path.dirname(legacyFixture)), { recursive: true });
fs.writeFileSync(
  path.join(fixtureRoot, validFixture),
  [
    "---",
    'title: "有效稿件"',
    'author: "2501 作者"',
    'author_display: "作者"',
    'received_date: "2026-07-09"',
    'editor: "张哲源"',
    'editor_username: "SaviorZhang211"',
    'status: "待责编审阅"',
    "---",
    "正文"
  ].join("\n")
);
fs.writeFileSync(
  path.join(fixtureRoot, legacyFixture),
  [
    "---",
    'title: "历史占位稿"',
    'author: "班级 作者"',
    'author_display: "作者实际署名"',
    'create_date: "2026-05-28"',
    'editor: "对应责编"',
    'editor_username: "对应责编的 GitHub 用户名"',
    'status: "未开始"',
    "---",
    "正文"
  ].join("\n")
);
fs.writeFileSync(path.join(fixtureRoot, "metadata.json"), JSON.stringify(config));

try {
  const incrementalCheck = spawnSync(
    process.execPath,
    [path.join(repositoryRoot, "scripts/check_metadata.js")],
    {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        CHECK_METADATA_FILES: validFixture,
        METADATA_CONFIG_PATH: path.join(fixtureRoot, "metadata.json"),
        GITHUB_EVENT_NAME: "",
        GITHUB_EVENT_PATH: "",
        GITHUB_REPOSITORY: "",
        GITHUB_TOKEN: ""
      }
    }
  );

  assert.strictEqual(
    incrementalCheck.status,
    0,
    incrementalCheck.stdout + incrementalCheck.stderr
  );
  assert.match(incrementalCheck.stdout, /共检查 1 个稿件文件/);

  const emptyManualCheck = spawnSync(
    process.execPath,
    [path.join(repositoryRoot, "scripts/check_metadata.js")],
    {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        CHECK_METADATA_FILES: "",
        METADATA_CONFIG_PATH: path.join(fixtureRoot, "metadata.json"),
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_EVENT_PATH: "",
        GITHUB_REPOSITORY: "",
        GITHUB_TOKEN: ""
      }
    }
  );

  assert.strictEqual(emptyManualCheck.status, 1);
  assert.match(emptyManualCheck.stdout, /手动运行元数据检查时必须指定至少一个稿件文件/);
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log("journal_rules tests passed.");
