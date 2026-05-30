const fs = require("fs");
const {
  loadConfig,
  parseFrontmatter,
  validateMetadata,
  isArticleMarkdown
} = require("./journal_rules");

async function api(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }

  return text ? JSON.parse(text) : null;
}

async function listPullRequestFiles() {
  const eventPath = process.env.GITHUB_EVENT_PATH;

  if (!eventPath || !fs.existsSync(eventPath)) {
    return [];
  }

  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));

  if (!event.pull_request) {
    return [];
  }

  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;

  if (!token) {
    throw new Error("Missing GITHUB_TOKEN.");
  }

  if (!repository) {
    throw new Error("Missing GITHUB_REPOSITORY.");
  }

  const [owner, repo] = repository.split("/");
  const result = [];

  for (let page = 1; ; page++) {
    const files = await api(
      `/repos/${owner}/${repo}/pulls/${event.pull_request.number}/files?per_page=100&page=${page}`,
      token
    );

    result.push(...files);

    if (files.length < 100) {
      break;
    }
  }

  return result;
}

function listExplicitFiles() {
  return String(process.env.CHECK_METADATA_FILES || "")
    .split(/[\n,]/)
    .map(file => file.trim())
    .filter(Boolean)
    .map(filename => ({ filename, status: "modified" }));
}

async function main() {
  const config = loadConfig();
  const changedFiles = [
    ...listExplicitFiles(),
    ...await listPullRequestFiles()
  ];
  const files = changedFiles
    .filter(file => file.status !== "removed")
    .map(file => file.filename)
    .filter(filename => isArticleMarkdown(config, filename));
  const errors = [];

  if (files.length === 0) {
    console.log("元数据检查通过。此 PR 没有需要检查的稿件 Markdown 文件。");
    return;
  }

  for (const file of files) {
    try {
      const text = fs.readFileSync(file, "utf8");
      const data = parseFrontmatter(text, file);
      validateMetadata(config, file, data);
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

main().catch(error => {
  console.log("元数据检查失败：");
  console.log(`- ${error.message || error}`);
  process.exit(1);
});
