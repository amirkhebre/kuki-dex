/**
 * Publish the KUKI DEX repository to GitHub using the Git Data API
 * (no git binary required).
 *
 *   node scripts/github-publish.mjs [repo-name]
 *
 * Requires .github-token from scripts/github-login.mjs.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const TOKEN_FILE = ".github-token";
if (!existsSync(TOKEN_FILE)) throw new Error("run scripts/github-login.mjs first");
const token = readFileSync(TOKEN_FILE, "utf8").trim();
const repoName = (process.argv[2] ?? "kuki-dex").trim();

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", ".wrangler", ".tmp"]);
const SKIP_FILES = new Set([
  ".env",
  ".env.local",
  ".relayer.json",
  ".github-token",
  ".github-device.json",
  "web-preview.png",
  "pnpm-lock.yaml",
]);

const headers = {
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "user-agent": "kuki-dex",
  "x-github-api-version": "2022-11-28",
};

async function api(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${json.message ?? res.status}`);
  return json;
}

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".github-")) continue;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), base, out);
      continue;
    }
    if (SKIP_FILES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    const size = statSync(full).size;
    if (size > 4 * 1024 * 1024) continue;
    out.push({ full, path: relative(base, full).split("\\").join("/"), size });
  }
  return out;
}

const user = await api("/user");
console.log(`user: ${user.login}`);

let repo;
try {
  repo = await api(`/repos/${user.login}/${repoName}`);
  console.log(`repo exists: ${repo.html_url}`);
} catch {
  repo = await api("/user/repos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: repoName,
      description: "KUKI DEX — KUKI-quoted AMM on TON with a profit-guarded arbitrage bot",
      private: false,
      has_issues: true,
      has_wiki: false,
    }),
  });
  console.log(`repo created: ${repo.html_url}`);
}

// The Git Data API refuses to create blobs in a repository with zero commits.
// Seed it with a placeholder README through the Contents API first.
try {
  await api(`/repos/${user.login}/${repoName}/contents/README.md`);
} catch {
  await api(`/repos/${user.login}/${repoName}/contents/README.md`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: "initialize repository",
      content: Buffer.from("# KUKI DEX\n\nDeployment in progress.\n").toString("base64"),
    }),
  });
  console.log("repository initialized");
}

const files = walk(process.cwd()).filter((f) => f.path !== "");
console.log(`uploading ${files.length} files…`);

const tree = [];
for (const file of files) {
  const content = readFileSync(file.full).toString("base64");
  const blob = await api(`/repos/${user.login}/${repoName}/git/blobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, encoding: "base64" }),
  });
  tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
}

const newTree = await api(`/repos/${user.login}/${repoName}/git/trees`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ tree }),
});

const ref = await api(`/repos/${user.login}/${repoName}/git/ref/heads/${repo.default_branch || "main"}`).catch(() => null);
const commit = await api(`/repos/${user.login}/${repoName}/git/commits`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    message: "KUKI DEX: weighted pools, native TON, bot with profit guard, web app",
    tree: newTree.sha,
    parents: ref ? [ref.object.sha] : [],
  }),
});

if (ref) {
  await api(`/repos/${user.login}/${repoName}/git/refs/heads/${repo.default_branch || "main"}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sha: commit.sha, force: true }),
  });
} else {
  await api(`/repos/${user.login}/${repoName}/git/refs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${repo.default_branch || "main"}`, sha: commit.sha }),
  });
}

console.log(`done: ${repo.html_url}`);
