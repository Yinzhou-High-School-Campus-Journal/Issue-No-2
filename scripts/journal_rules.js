const fs = require("fs");
const path = require("path");

function loadConfig(configPath = ".journal/metadata.json") {
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function normalizeLogin(value) {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}

function walk(dir) {
  const result = [];

  if (!fs.existsSync(dir)) {
    return result;
  }

  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);

    if (stat.isDirectory()) {
      result.push(...walk(full));
    } else if (stat.isFile()) {
      result.push(full);
    }
  }

  return result;
}

function toRepoPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function parseFrontmatter(text, filename) {
  const normalized = text.replace(/\r\n/g, "\n");

  if (!normalized.startsWith("---\n")) {
    throw new Error(`${filename}: 缺少 YAML 元数据块，文件必须以 --- 开头`);
  }

  const end = normalized.indexOf("\n---", 4);

  if (end === -1) {
    throw new Error(`${filename}: 元数据块缺少结束的 ---`);
  }

  const raw = normalized.slice(4, end).trim();
  const data = {};

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^([A-Za-z0-9_]+):\s*(.*)$/);

    if (!match) {
      throw new Error(`${filename}: 元数据行格式错误：${line}`);
    }

    const key = match[1];
    let value = match[2].trim();

    value = value.replace(/^["']/, "").replace(/["']$/, "");

    if (Object.prototype.hasOwnProperty.call(data, key)) {
      throw new Error(`${filename}: 元数据字段重复：${key}`);
    }

    data[key] = value;
  }

  return data;
}

function checkDate(value, filename, field) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${filename}: ${field} 必须使用 yyyy-mm-dd 格式`);
  }

  const date = new Date(`${value}T00:00:00Z`);

  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${filename}: ${field} 不是有效日期：${value}`);
  }
}

function allowedEditorsForFile(config, filename) {
  return config.editorRules.filter(rule =>
    rule.paths.some(prefix => filename.startsWith(prefix))
  );
}

function validateMetadata(config, filename, data) {
  const allowedFields = new Set([
    ...config.requiredFields,
    ...config.dateFields,
    ...config.optionalFields
  ]);

  for (const field of Object.keys(data)) {
    if (!allowedFields.has(field)) {
      throw new Error(`${filename}: 不允许的元数据字段：${field}`);
    }
  }

  for (const field of config.requiredFields) {
    if (!data[field] || String(data[field]).trim() === "") {
      throw new Error(`${filename}: 缺少必填字段：${field}`);
    }
  }

  const presentDateFields = config.dateFields.filter(field => data[field]);

  if (presentDateFields.length !== 1) {
    throw new Error(`${filename}: received_date 与 create_date 必须且只能填写其中一个`);
  }

  for (const field of presentDateFields) {
    checkDate(data[field], filename, field);
  }

  const createDateRequired = (config.createDateRoots || [])
    .some(prefix => filename.startsWith(prefix));

  if (createDateRequired && !data.create_date) {
    throw new Error(`${filename}: 该目录下的文件必须使用 create_date，而不是 received_date`);
  }

  if (!config.allowedStatuses.includes(data.status)) {
    throw new Error(
      `${filename}: status 不合法：${data.status}；允许值：${config.allowedStatuses.join("、")}`
    );
  }

  if (String(data.editor_username).startsWith("@")) {
    throw new Error(`${filename}: editor_username 不要带 @，只写 GitHub 用户名`);
  }

  if (/\s/.test(String(data.editor_username))) {
    throw new Error(`${filename}: editor_username 不能包含空格`);
  }

  const allowedEditors = allowedEditorsForFile(config, filename);

  if (allowedEditors.length === 0) {
    throw new Error(`${filename}: 文件不在任何已登记的责编目录下`);
  }

  const matched = allowedEditors.some(rule =>
    data.editor === rule.name &&
    normalizeLogin(data.editor_username) === normalizeLogin(rule.login)
  );

  if (!matched) {
    const expected = allowedEditors
      .map(rule => `${rule.name} / ${rule.login}`)
      .join(" 或 ");

    throw new Error(
      `${filename}: editor/editor_username 与所在目录不一致；允许：${expected}；实际：${data.editor} / ${data.editor_username}`
    );
  }
}

function listArticleFiles(config) {
  return walk(config.articleRoot)
    .filter(file => file.endsWith(".md"))
    .map(toRepoPath);
}

function isArticleMarkdown(config, filename) {
  return filename.startsWith(config.articleRoot) && filename.endsWith(".md");
}

function isTechnicalUser(config, login) {
  return config.technicalUsers
    .map(normalizeLogin)
    .includes(normalizeLogin(login));
}

module.exports = {
  loadConfig,
  normalizeLogin,
  parseFrontmatter,
  validateMetadata,
  listArticleFiles,
  isArticleMarkdown,
  isTechnicalUser
};
