const fs = require("fs");
const path = require("path");

const config = JSON.parse(fs.readFileSync(".journal/metadata.json", "utf8"));

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

function checkFile(filename) {
  const text = fs.readFileSync(filename, "utf8");
  const data = parseFrontmatter(text, filename);

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

  if (!config.allowedStatuses.includes(data.status)) {
    throw new Error(
      `${filename}: status 不合法：${data.status}；允许值：${config.allowedStatuses.join("、")}`
    );
  }

  if (String(data.editor_username).startsWith("@")) {
    throw new Error(`${filename}: editor_username 不要带 @，只写 GitHub 用户名`);
  }
}

function main() {
  const files = walk(config.articleRoot)
    .filter(file => file.endsWith(".md"))
    .map(toRepoPath);

  const errors = [];

  for (const file of files) {
    try {
      checkFile(file);
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (errors.length > 0) {
    console.log("元数据检查失败：");
    for (const error of errors) {
      console.log(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`元数据检查通过。共检查 ${files.length} 个稿件文件。`);
}

main();
