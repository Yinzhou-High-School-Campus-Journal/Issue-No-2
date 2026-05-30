const fs = require("fs");
const {
  loadConfig,
  normalizeLogin,
  parseFrontmatter,
  validateMetadata,
  isArticleMarkdown,
  isTechnicalUser
} = require("./journal_rules");

const config = loadConfig();
const token = process.env.BOT_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const eventPath = process.env.GITHUB_EVENT_PATH;

if (!eventPath) {
  throw new Error("Missing GITHUB_EVENT_PATH.");
}

const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));

if (!event.pull_request) {
  console.log("Not a pull request event. Skip.");
  process.exit(0);
}

if (!token) {
  throw new Error("Missing JOURNAL_BOT_TOKEN. Auto approval and merge cannot run.");
}

if (!repository) {
  throw new Error("Missing GITHUB_REPOSITORY.");
}

const pr = event.pull_request;
const actor = normalizeLogin(event.sender.login);
const [baseOwner, baseRepo] = repository.split("/");

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function api(path, options = {}) {
  const headers = {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28"
  };

  if (options.body) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`https://api.github.com${path}`, {
    method: options.method || "GET",
    headers,
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
