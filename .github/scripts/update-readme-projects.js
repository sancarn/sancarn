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

function renderLine(profile, repo, emoji) {
  const name = repo.name;
  const link = repo.html_url;
  const desc = repo.description || "";
  return `*  ${emoji} ![GHStars](https://img.shields.io/github/stars/${profile}/${name}?style&logo=github&label) [${name}](${link}) - ${desc}`;
}

async function main() {
  console.log(`Fetching repos for ${PROFILE}…`);
  const repos = await fetchAllRepos(PROFILE);
  console.log(`Found ${repos.length} repos. Fetching latest commit dates…`);

  const reposWithDates = await Promise.all(
    repos.map(async (repo) => {
      const latestCommit = await fetchLatestCommitDate(PROFILE, repo.name);
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
    return renderLine(PROFILE, repo, emoji);
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
