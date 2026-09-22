// 中文热榜抓取脚本：微博 + 百度 + 抖音 + GitHub(AI简介)
// 零依赖，Node.js 内置 https + fetch(Node 18+)
const https = require('https');
const fs = require('fs');
const path = require('path');

const TIMEOUT = 15000;
const AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 HotNewsBot';
const AI_MAX_REPOS = 5; // 只总结前 N 个，省时间/钱

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: TIMEOUT, headers: { 'User-Agent': AGENT, ...headers } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(d);
        else reject(new Error(`HTTP ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// POST（用于 AI 调用，https 模块 + 可靠 timeout）
function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      timeout: 15000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(d);
        else reject(new Error(`HTTP ${res.statusCode}: ${d?.substring(0, 100)}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

// AI 调用：https.request 调 Worker（GitHub Actions 上 fetch 有问题）
async function aiCall(repo) {
  const body = JSON.stringify({
    messages: [{ role: 'user', content: `GitHub仓库: ${repo.full_name}\n描述: ${repo.description || '(无)'}\n\n用中文一句话30字内说清这个项目做什么，直接输出。` }],
    max_tokens: 60,
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'cloudflare-cron-trigger.486569.workers.dev',
      path: '/ai?secret=hotnews-ai-proxy-2026',
      method: 'POST', timeout: 30000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve((JSON.parse(d).choices?.[0]?.message?.content || '').trim()); }
          catch(e) { resolve(''); }
        } else { reject(new Error('HTTP ' + res.statusCode)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body); req.end();
  });
}

// AI 总结（限制数量 + 串行，通过 Cloudflare Worker 代理）
async function aiSummarize(repos) {
  const targets = repos.slice(0, AI_MAX_REPOS);
  const results = [];
  for (const repo of repos) {
    if (repo.summary !== undefined) { results.push(repo); continue; } // 已有 summary
    if (!targets.find(t => t.full_name === repo.full_name)) {
      results.push({ ...repo, summary: '' }); continue; // 不在前 N
    }
    try {
      const summary = await aiCall(repo);
      results.push({ ...repo, summary });
      process.stdout.write('.');
    } catch (e) {
      results.push({ ...repo, summary: '' });
      process.stdout.write('x'); console.error(' ', e.message?.substring(0,80));
    }
    await new Promise(r => setTimeout(r, 500));
  }
  const ok = results.filter(r => r.summary).length;
  console.log(` [AI ${ok}/${targets.length} OK]`);
  return results;
}

async function fetchWeibo() {
  try {
    const html = await get('https://weibo.com/ajax/side/hotSearch', { Referer: 'https://weibo.com/' });
    const j = JSON.parse(html);
    return (j.data.realtime || []).slice(0, 15).map((it, i) => ({
      title: it.note || it.word || '',
      hot: it.num ? String(Math.round(it.num / 10000)) + '万' : '',
      url: `https://s.weibo.com/weibo?q=${encodeURIComponent('#' + (it.word || it.note) + '#')}`,
      source: 'weibo', tag: i === 0 ? '爆' : i < 3 ? '热' : '',
    }));
  } catch (e) { console.log('   微博 失败:', e.message); return []; }
}

async function fetchBaidu() {
  try {
    const html = await get('https://top.baidu.com/api/board?platform=wise&tab=realtime');
    const j = JSON.parse(html);
    const list = ((j.data?.cards?.[0]?.content?.[0]?.content) || []).slice(0, 15);
    return list.map((it, i) => ({
      title: it.word || '',
      hot: it.isTop ? '置顶' : `TOP ${i + 1}`,
      url: it.url || `https://www.baidu.com/s?wd=${encodeURIComponent(it.word || '')}`,
      source: 'baidu', tag: it.labelTagName || it.newHotName || '',
    }));
  } catch (e) { console.log('   百度 失败:', e.message); return []; }
}

async function fetchDouyin() {
  try {
    const html = await get('https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/');
    const j = JSON.parse(html);
    return (j.word_list || []).slice(0, 15).map((it) => ({
      title: it.word || '',
      hot: it.hot_value ? String(Math.round(it.hot_value / 10000)) + '万' : '',
      url: `https://www.douyin.com/search/${encodeURIComponent(it.word || '')}`,
      source: 'douyin', tag: '',
    }));
  } catch (e) { console.log('   抖音 失败:', e.message); return []; }
}

async function fetchGithub() {
  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const html = await get(`https://api.github.com/search/repositories?q=created:>=${weekAgo}&sort=stars&order=desc&per_page=15`, { Accept: 'application/vnd.github+json' });
    const j = JSON.parse(html);
    const repos = (j.items || []).map((it) => ({
      full_name: it.full_name, description: it.description || '',
      stars: it.stargazers_count, url: it.html_url || '', language: it.language || '',
    }));
    const enriched = await aiSummarize(repos);
    return enriched.map((it) => ({
      title: it.summary ? `${it.full_name} —— ${it.summary}` : it.full_name,
      hot: `⭐ ${it.stars}`, url: it.url, source: 'github', tag: it.language,
    }));
  } catch (e) { console.log('   GitHub 失败:', e.message); return []; }
}

async function main() {
  console.log('🚀 开始抓取...');
  console.log(`   AI: Qwen3.5-9B via Cloudflare Worker (前${AI_MAX_REPOS}个)\n`);

  const now = new Date().toISOString();
  const results = { updatedAt: now, source: 'live' };

  await Promise.allSettled([
    fetchWeibo().then(d => { results.weibo = d; console.log(`   🔥 微博: ${d.length}`); }),
    fetchBaidu().then(d => { results.baidu = d; console.log(`   🔍 百度: ${d.length}`); }),
    fetchDouyin().then(d => { results.douyin = d; console.log(`   🎵 抖音: ${d.length}`); }),
  ]);

  results.github = await fetchGithub();
  console.log(`   ⭐ GitHub: ${results.github.length}`);

  const platforms = ['weibo', 'baidu', 'douyin', 'github'];
  for (const p of platforms) if (!results[p] || results[p].length === 0) results[p] = [{ title: '暂无数据', source: p }];

  const total = platforms.reduce((s, p) => s + results[p].length, 0);
  console.log(`\n✅ 总计 ${total}`);

  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'hot-news.json'), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(dataDir, 'hot-news.min.json'), JSON.stringify(results));
  for (const p of platforms) {
    fs.writeFileSync(path.join(dataDir, `${p}.json`), JSON.stringify({ data: results[p], updatedAt: now }, null, 2));
  }
  fs.writeFileSync(path.join(dataDir, 'update-time.txt'), now);
  console.log('✅ 已写入');
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
