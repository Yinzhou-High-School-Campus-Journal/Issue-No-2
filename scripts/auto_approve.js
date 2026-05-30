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

  return Buffer.from(String(data.content).replace(/\n/g, ""), "base64").toString("utf8");
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
      body: "已根据稿件负责人规则自动批准。"
    }
  });

  console.log("Approved by bot.");
}

async function canApproveAddedFile(file) {
  const filename = file.filename;
  const headText = await getHeadContent(filename);
  const headMeta = parseFrontmatter(headText, filename);

  validateMetadata(config, filename, headMeta);

  const headEditor = normalizeLogin(headMeta.editor_username);

  if (isTechnicalUser(config, actor)) {
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

  validateMetadata(config, filename, baseMeta);
  validateMetadata(config, filename, headMeta);

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

async function verifyChangedFiles() {
  const files = await listChangedFiles();

  if (files.length === 0) {
    console.log("No changed files. Skip.");
    return false;
  }

  for (const file of files) {
    const filename = file.filename;

    if (!isArticleMarkdown(config, filename)) {
      console.log(`Skip: non-article file changed: ${filename}.`);
      return false;
    }

    if (file.status === "added") {
      const ok = await canApproveAddedFile(file);

      if (!ok) {
        console.log(`Skip: added file not allowed for actor ${actor}: ${filename}.`);
        return false;
      }

      continue;
    }

    if (file.status === "modified") {
      const ok = await canApproveModifiedFile(file);

      if (!ok) {
        return false;
      }

      continue;
    }

    console.log(`Skip: unsupported file status ${file.status} for ${filename}.`);
    return false;
  }

  return true;
}

function latestCheckRunByName(checkRuns, name) {
  const runs = checkRuns
    .filter(run => run.name === name)
    .sort((a, b) => {
      const aTime = new Date(a.started_at || a.created_at || 0).getTime();
      const bTime = new Date(b.started_at || b.created_at || 0).getTime();
      return bTime - aTime;
    });

  return runs[0] || null;
}

async function waitForRequiredChecks() {
  const requiredChecks = config.requiredChecksBeforeMerge || [];

  if (requiredChecks.length === 0) {
    console.log("No required checks configured before merge.");
    return;
  }

  const timeoutSeconds = Number(config.requiredCheckTimeoutSeconds || 180);
  const pollSeconds = Number(config.requiredCheckPollSeconds || 5);
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    const data = await api(
      `/repos/${baseOwner}/${baseRepo}/commits/${pr.head.sha}/check-runs?per_page=100`
    );

    const checkRuns = data.check_runs || [];
    const pending = [];

    for (const name of requiredChecks) {
      const run = latestCheckRunByName(checkRuns, name);

      if (!run) {
        pending.push(`${name}: not found`);
        continue;
      }

      if (run.status !== "completed") {
        pending.push(`${name}: ${run.status}`);
        continue;
      }

      if (run.conclusion !== "success") {
        throw new Error(`${name} failed with conclusion: ${run.conclusion}`);
      }
    }

    if (pending.length === 0) {
      console.log(`Required checks passed: ${requiredChecks.join(", ")}`);
      return;
    }

    console.log(`Waiting for required checks: ${pending.join("; ")}`);
    await sleep(pollSeconds * 1000);
  }

  throw new Error(`Timed out waiting for required checks: ${requiredChecks.join(", ")}`);
}

async function mergePullRequest() {
  const current = await api(`/repos/${baseOwner}/${baseRepo}/pulls/${pr.number}`);

  if (current.state !== "open") {
    console.log(`PR is ${current.state}. Skip merge.`);
    return;
  }

  if (current.draft) {
    console.log("PR is draft. Skip merge.");
    return;
  }

  if (current.head.sha !== pr.head.sha) {
    throw new Error(
      `PR head changed from ${pr.head.sha} to ${current.head.sha}. Wait for the new workflow run.`
    );
  }

  const mergeMethod = config.mergeMethod || "squash";

  const result = await api(`/repos/${baseOwner}/${baseRepo}/pulls/${pr.number}/merge`, {
    method: "PUT",
    body: {
      sha: pr.head.sha,
      merge_method: mergeMethod,
      commit_title: `${pr.title} (#${pr.number})`,
      commit_message: "Automatically merged after journal ownership and metadata checks."
    }
  });

  if (!result.merged) {
    throw new Error(`Merge API did not merge PR: ${result.message || "unknown reason"}`);
  }

  console.log(`Merged PR #${pr.number}: ${result.sha}`);
}

async function main() {
  if (pr.draft) {
    console.log("Draft PR. Skip.");
    return;
  }

  if (pr.state !== "open") {
    console.log(`PR is ${pr.state}. Skip.`);
    return;
  }

  if (actor === normalizeLogin(config.botLogin)) {
    console.log("Actor is bot itself. Skip.");
    return;
  }

  if (normalizeLogin(pr.user.login) === normalizeLogin(config.botLogin)) {
    console.log("PR author is bot itself. Skip.");
    return;
  }

  const allowed = await verifyChangedFiles();

  if (!allowed) {
    console.log("PR is not eligible for automatic approval and merge.");
    return;
  }

  await approve();
  await waitForRequiredChecks();
  await mergePullRequest();
}

main().catch(error => {
  console.log("Auto approval and merge failed:");
  console.log(error.message || error);
  process.exit(1);
});
