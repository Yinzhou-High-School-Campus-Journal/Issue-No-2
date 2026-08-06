const fs = require("fs");
const path = require("path");
const YAML = require("yaml");

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
  const normalized = String(text)
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");

  if (lines[0] !== "---") {
    throw new Error(`${filename}: 缺少 YAML 元数据块，文件必须以 --- 开头`);
  }

  const end = lines.indexOf("---", 1);

  if (end === -1) {
    throw new Error(`${filename}: 元数据块缺少结束的 ---`);
  }

  const raw = lines.slice(1, end).join("\n");
  const document = YAML.parseDocument(raw, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true
  });

  if (document.errors.length > 0) {
    const message = String(document.errors[0].message || document.errors[0])
      .split("\n")[0];
    throw new Error(`${filename}: YAML 元数据语法错误：${message}`);
  }

  let data;

  try {
    data = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new Error(`${filename}: YAML 元数据解析失败：${error.message || error}`);
  }

  if (data === null) {
    data = {};
  }

  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${filename}: YAML 元数据顶层必须是键值对象`);
  }

  for (const [field, value] of Object.entries(data)) {
    if (typeof value !== "string") {
      throw new Error(`${filename}: 元数据字段 ${field} 的值必须是字符串`);
    }
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

function collectMetadataErrors(config, filename, data) {
  const errors = [];
  const addError = message => errors.push(`${filename}: ${message}`);

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return [`${filename}: 元数据必须是键值对象`];
  }

  const allowedFields = new Set([
    ...config.requiredFields,
    ...config.dateFields,
    ...config.optionalFields
  ]);

  for (const [field, value] of Object.entries(data)) {
    if (!allowedFields.has(field)) {
      addError(`不允许的元数据字段：${field}`);
    }

    if (value !== undefined && typeof value !== "string") {
      addError(`元数据字段 ${field} 的值必须是字符串`);
    }
  }

  for (const field of config.requiredFields) {
    if (typeof data[field] !== "string" || data[field].trim() === "") {
      addError(`缺少必填字段：${field}`);
    }
  }

  const presentDateFields = config.dateFields.filter(field =>
    typeof data[field] === "string" && data[field].trim() !== ""
  );

  if (presentDateFields.length !== 1) {
    addError("received_date 与 create_date 必须且只能填写其中一个");
  }

  for (const field of presentDateFields) {
    try {
      checkDate(data[field], filename, field);
    } catch (error) {
      errors.push(error.message);
    }
  }

  const createDateRequired = (config.createDateRoots || [])
    .some(prefix => filename.startsWith(prefix));

  if (createDateRequired && !data.create_date) {
    addError("该目录下的文件必须使用 create_date，而不是 received_date");
  }

  if (
    presentDateFields.length === 1 &&
    typeof data.status === "string" &&
    data.status.trim() !== ""
  ) {
    const dateField = presentDateFields[0];
    const allowedStatuses = config.statusByDateField?.[dateField];

    if (!Array.isArray(allowedStatuses)) {
      addError(`元数据配置缺少 ${dateField} 对应的 status 规则`);
    } else if (!allowedStatuses.includes(data.status)) {
      addError(
        `status 与 ${dateField} 不匹配：${data.status}；允许值：${allowedStatuses.join("、")}`
      );
    }
  }

  if (typeof data.editor_username === "string") {
    if (data.editor_username.startsWith("@")) {
      addError("editor_username 不要带 @，只写 GitHub 用户名");
    }

    if (/\s/.test(data.editor_username)) {
      addError("editor_username 不能包含空格");
    }
  }

  const allowedEditors = allowedEditorsForFile(config, filename);

  if (allowedEditors.length === 0) {
    addError("文件不在任何已登记的责编目录下");
  }

  if (
    allowedEditors.length > 0 &&
    typeof data.editor === "string" &&
    data.editor.trim() !== "" &&
    typeof data.editor_username === "string" &&
    data.editor_username.trim() !== ""
  ) {
    const matched = allowedEditors.some(rule =>
      data.editor === rule.name &&
      normalizeLogin(data.editor_username) === normalizeLogin(rule.login)
    );

    if (!matched) {
      const expected = allowedEditors
        .map(rule => `${rule.name} / ${rule.login}`)
        .join(" 或 ");

      addError(
        `editor/editor_username 与所在目录不一致；允许：${expected}；实际：${data.editor} / ${data.editor_username}`
      );
    }
  }

  return errors;
}

function validateMetadata(config, filename, data) {
  const errors = collectMetadataErrors(config, filename, data);

  if (errors.length === 0) {
    return;
  }

  const error = new Error(errors.join("\n"));
  error.name = "MetadataValidationError";
  error.errors = errors;
  throw error;
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
  collectMetadataErrors,
  validateMetadata,
  listArticleFiles,
  isArticleMarkdown,
  isTechnicalUser
};
