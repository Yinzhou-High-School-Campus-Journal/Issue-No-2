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
