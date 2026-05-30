const fs = require("fs");

const token = process.env.BOT_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const config = JSON.parse(fs.readFileSync(".journal/metadata.json", "utf8"));

if (!event.pull_request) {
  console.log("Not a pull request event. Skip.");
  process.exit(0);
}

if (!token) {
  console.log("Missing JOURNAL_BOT_TOKEN. Skip auto-approval.");
  process.exit(0);
}

const pr = event.pull_request;
const actor = normalizeLogin(event.sender.login);
const [baseOwner, baseRepo] = repository.split("/");

function normalizeLogin(value) {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
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

function allowedEditorsForFile(filename) {
  return config.editorRules.filter(rule =>
    rule.paths.some(prefix => filename.startsWith(prefix))
  );
}

function validateMetadata(filename, data) {
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

  if (/\s/.test(String(data.editor_username))) {
    throw new Error(`${filename}: editor_username 不能包含空格`);
  }

  const allowedEditors = allowedEditorsForFile(filename);

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

function isArticleMarkdown(filename) {
  return filename.startsWith(config.articleRoot) && filename.endsWith(".md");
}

function isTechnicalUser(login) {
  return config.technicalUsers
    .map(normalizeLogin)
    .includes(normalizeLogin(login));
}

async function api(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method: options.method || "GET",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }

  return text ? JSON.parse(text) : null;
}

async function listChangedFiles() {
  const files = [];

  for (let page = 1; ; page++) {
    const batch = await api(
      `/repos/${baseOwner}/${baseRepo}/pulls/${pr.number}/files?per_page=100&page=${page}`
    );

    files.push(...batch);

    if (batch.length < 100) {
      break;
    }
  }

  return files;
}

async function getContentFromRepo(fullName, filename, ref) {
  const [owner, repo] = fullName.split("/");
  const data = await api(
    `/repos/${owner}/${repo}/contents/${encodePath(filename)}?ref=${encodeURIComponent(ref)}`
  );

  if (data.type !== "file") {
    throw new Error(`${filename}: 不是普通文件`);
  }

  return Buffer.from(data.content, "base64").toString("utf8");
}

async function getHeadContent(filename) {
  return getContentFromRepo(pr.head.repo.full_name, filename, pr.head.sha);
}

async function getBaseContent(filename) {
  return getContentFromRepo(pr.base.repo.full_name, filename, pr.base.sha);
}

async function approve() {
  await api(`/repos/${baseOwner}/${baseRepo}/pulls/${pr.number}/reviews`, {
    method: "POST",
    body: {
      event: "APPROVE",
      body: "🤖 已根据稿件负责人规则自动批准。"
    }
  });
}

async function canApproveAddedFile(file) {
  const filename = file.filename;
  const headText = await getHeadContent(filename);
  const headMeta = parseFrontmatter(headText, filename);

  validateMetadata(filename, headMeta);

  const headEditor = normalizeLogin(headMeta.editor_username);

  if (isTechnicalUser(actor)) {
    return true;
  }

  return actor === headEditor;
}

async function canApproveModifiedFile(file) {
  const filename = file.filename;
  const baseText = await getBaseContent(filename);
  const headText = await getHeadContent(filename);

  const baseMeta = parseFrontmatter(baseText, filename);
  const headMeta = parseFrontmatter(headText, filename);

  validateMetadata(filename, baseMeta);
  validateMetadata(filename, headMeta);

  const baseEditorUsername = normalizeLogin(baseMeta.editor_username);
  const headEditorUsername = normalizeLogin(headMeta.editor_username);

  if (actor !== baseEditorUsername) {
    console.log(
      `Skip: actor ${actor} is not responsible editor ${baseEditorUsername} for ${filename}.`
    );
    return false;
  }

  if (baseMeta.editor !== headMeta.editor) {
    console.log(`Skip: editor changed in ${filename}.`);
    return false;
  }

  if (baseEditorUsername !== headEditorUsername) {
    console.log(`Skip: editor_username changed in ${filename}.`);
    return false;
  }

  return true;
}

async function main() {
  if (actor === normalizeLogin(config.botLogin)) {
    console.log("Actor is bot itself. Skip.");
    return;
  }

  const files = await listChangedFiles();

  if (files.length === 0) {
    console.log("No changed files. Skip.");
    return;
  }

  for (const file of files) {
    const filename = file.filename;

    if (!isArticleMarkdown(filename)) {
      console.log(`Skip: non-article file changed: ${filename}.`);
      return;
    }

    if (file.status === "added") {
      const ok = await canApproveAddedFile(file);

      if (!ok) {
        console.log(`Skip: added file not allowed for actor ${actor}: ${filename}.`);
        return;
      }

      continue;
    }

    if (file.status === "modified") {
      const ok = await canApproveModifiedFile(file);

      if (!ok) {
        return;
      }

      continue;
    }

    console.log(`Skip: unsupported file status ${file.status} for ${filename}.`);
    return;
  }

  await approve();
  console.log("Approved by bot.");
}

main().catch(error => {
  console.log("Auto-approval skipped because of an error:");
  console.log(error.message || error);
  process.exit(0);
});
