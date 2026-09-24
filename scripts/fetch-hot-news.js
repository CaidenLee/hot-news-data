// hot-news-data 热榜抓取脚本
// 数据源: Cloudflare Worker（自部署热榜 API）+ GitHub API
// 零依赖，Node.js 内置 https

const https = require("https");
const fs = require("fs");
const path = require("path");

const WORKER = "https://cloudflare-cron-trigger.486569.workers.dev";
const WORKER_SECRET = "hotnews-api-2026";
const TIMEOUT = 20000;

// 要抓的源（抖音已删，cookie 机制复杂）
const SOURCES = [
  { key: "weibo",      label: "微博",      icon: "🔥" },
  { key: "zhihu",      label: "知乎",      icon: "📚" },
  { key: "baidu",      label: "百度",      icon: "🔍" },
  { key: "36kr",       label: "36氪",      icon: "💡" },
  { key: "juejin",     label: "掘金",      icon: "⛏️" },
  { key: "hackernews", label: "HackerNews", icon: "👾" },
];

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: TIMEOUT, headers }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(d);
        else reject(new Error(`HTTP ${res.statusCode}: ${d.substring(0, 100)}`));
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// 从 Worker 抓单个热榜源
async function fetchFromWorker(source) {
  try {
    const html = await get(`${WORKER}/api/${source.key}?secret=${WORKER_SECRET}`);
    const j = JSON.parse(html);
    const data = (j.data || []).slice(0, 15).map((it) => ({
      title: it.title || "",
      hot: it.hot || "",
      url: it.url || "",
      source: source.label,
    }));
    console.log(`   ${source.icon} ${source.label}: ${data.length}`);
    return data;
  } catch (e) {
    console.log(`   ${source.icon} ${source.label} 失败: ${e.message}`);
    return [];
  }
}

async function fetchGithub() {
  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const html = await get(
      `https://api.github.com/search/repositories?q=created:>=${weekAgo}&sort=stars&order=desc&per_page=15`,
      { Accept: "application/vnd.github+json", "User-Agent": "hot-news-data" }
    );
    const j = JSON.parse(html);
    console.log(`   ⭐ GitHub: ${(j.items || []).length}`);
    return (j.items || []).map((it) => ({
      title: it.description ? `${it.full_name} —— ${it.description.substring(0, 40)}` : it.full_name,
      hot: `⭐ ${it.stargazers_count}`,
      url: it.html_url || "",
      source: "GitHub",
      tag: it.language || "",
    }));
  } catch (e) { console.log(`   ⭐ GitHub 失败: ${e.message}`); return []; }
}

async function main() {
  console.log("🚀 开始抓取...");
  console.log(`   数据源: Cloudflare Worker (${SOURCES.length}源) + GitHub`);
  console.log(`   Worker: ${WORKER}\n`);

  const now = new Date().toISOString();
  const results = { updatedAt: now, dailyhot: {} };

  const tasks = SOURCES.map((s) =>
    fetchFromWorker(s).then((d) => { results.dailyhot[s.key] = d; })
  );
  await Promise.allSettled(tasks);

  results.github = await fetchGithub();

  for (const s of SOURCES) {
    if (!results.dailyhot[s.key] || results.dailyhot[s.key].length === 0) {
      results.dailyhot[s.key] = [{ title: "暂无数据", source: s.label }];
    }
  }
  if (results.github.length === 0) results.github = [{ title: "暂无数据", source: "GitHub" }];

  let total = results.github.length;
  for (const k in results.dailyhot) total += results.dailyhot[k].length;
  console.log(`\n✅ 总计 ${total}`);

  const dataDir = path.join(__dirname, "..", "data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "hot-news.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(dataDir, "hot-news.min.json"), JSON.stringify(results));
  fs.writeFileSync(path.join(dataDir, "update-time.txt"), now);
  console.log("✅ 已写入");
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
