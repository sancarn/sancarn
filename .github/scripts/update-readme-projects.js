const fs = require("fs");
const path = require("path");

const PROFILE = process.env.GITHUB_PROFILE;
const TOKEN = process.env.GITHUB_TOKEN;
const REPO_ROOT = process.env.GITHUB_WORKSPACE || process.cwd();

if (!PROFILE) {
  console.error("GITHUB_PROFILE env var is required");
  process.exit(1);
}

const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "readme-project-list",
};
if (TOKEN) {
  headers.Authorization = `Bearer ${TOKEN}`;
}

async function ghFetch(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${res.statusText} – ${url}`);
  }
  return res;
}

async function fetchAllRepos(profile) {
  const repos = [];
  let page = 1;
  while (true) {
    const url = `https://api.github.com/users/${profile}/repos?per_page=100&type=owner&page=${page}`;
    const res = await ghFetch(url);
    const batch = await res.json();
    if (batch.length === 0) break;
    repos.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return repos;
}

async function fetchUserOrgs() {
  if (!TOKEN) return [];
  const res = await ghFetch("https://api.github.com/user/orgs?per_page=100");
  return res.json();
}

async function fetchOrgPublicRepos(orgLogin) {
  const repos = [];
  let page = 1;
  while (true) {
    const url = `https://api.github.com/orgs/${orgLogin}/repos?per_page=100&type=public&page=${page}`;
    try {
      const res = await ghFetch(url);
      const batch = await res.json();
      if (batch.length === 0) break;
      repos.push(...batch);
      if (batch.length < 100) break;
      page++;
    } catch {
      break;
    }
  }
  return repos;
}

async function repoHasUserCommits(owner, repo, author) {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits?author=${encodeURIComponent(author)}&per_page=1`;
  try {
    const res = await ghFetch(url);
    const commits = await res.json();
    return Array.isArray(commits) && commits.length > 0;
  } catch {
    return false;
  }
}

async function fetchLatestCommitDate(owner, repo) {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits?per_page=1`;
  try {
    const res = await ghFetch(url);
    const commits = await res.json();
    if (commits.length > 0 && commits[0].commit) {
      return new Date(commits[0].commit.committer.date);
    }
  } catch {
    // empty repo or error – treat as very old
  }
  return new Date(0);
}

function loadScoring() {
  const scoringPath = path.join(REPO_ROOT, "scoring.json");
  const raw = fs.readFileSync(scoringPath, "utf-8");
  const scoring = JSON.parse(raw);
  scoring.thresholds.sort((a, b) => a.maxAgeDays - b.maxAgeDays);
  return scoring;
}

function emojiForAge(ageDays, scoring) {
  for (const t of scoring.thresholds) {
    if (ageDays <= t.maxAgeDays) return t.emoji;
  }
  return scoring.default;
}

function renderLine(owner, repo, emoji) {
  const name = repo.name;
  const link = repo.html_url;
  const desc = repo.description || "";
  return `*  ${emoji} ![GHStars](https://img.shields.io/github/stars/${owner}/${name}?style&logo=github&label) [${name}](${link}) - ${desc}`;
}

async function main() {
  console.log(`Fetching repos for ${PROFILE}…`);
  let repos = await fetchAllRepos(PROFILE);
  const byFullName = new Map(repos.map((r) => [r.full_name, r]));

  if (TOKEN) {
    console.log("Fetching org memberships…");
    const orgs = await fetchUserOrgs();
    for (const org of orgs) {
      const orgRepos = await fetchOrgPublicRepos(org.login);
      for (const repo of orgRepos) {
        if (byFullName.has(repo.full_name)) continue;
        const hasCommits = await repoHasUserCommits(repo.owner.login, repo.name, PROFILE);
        if (hasCommits) byFullName.set(repo.full_name, repo);
      }
    }
    repos = Array.from(byFullName.values());
    console.log(`Including org repos: ${repos.length} total repos.`);
  }

  console.log(`Fetching latest commit dates for ${repos.length} repos…`);
  const reposWithDates = await Promise.all(
    repos.map(async (repo) => {
      const owner = repo.owner.login;
      const latestCommit = await fetchLatestCommitDate(owner, repo.name);
      return { repo, latestCommit };
    })
  );

  reposWithDates.sort((a, b) => b.latestCommit - a.latestCommit);

  const scoring = loadScoring();
  const now = Date.now();
  const msPerDay = 86400000;

  const lines = reposWithDates.map(({ repo, latestCommit }) => {
    const ageDays = (now - latestCommit.getTime()) / msPerDay;
    const emoji = emojiForAge(ageDays, scoring);
    return renderLine(repo.owner.login, repo, emoji);
  });

  const projectList = lines.join("\n");

  const templatePath = path.join(REPO_ROOT, "README.template.md");
  const outputPath = path.join(REPO_ROOT, "README.md");

  const template = fs.readFileSync(templatePath, "utf-8");
  const result = template.replace("<!-- Projects -->", "<!-- Projects -->\n" + projectList);

  fs.writeFileSync(outputPath, result, "utf-8");
  console.log(`Wrote ${lines.length} projects to ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
