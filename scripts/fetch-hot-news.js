// 中文热榜抓取脚本：微博 + 百度 + 抖音 + GitHub(AI简介)
// 零依赖，Node.js 内置 https + fetch(Node 18+)
const https = require('https');
const fs = require('fs');
const path = require('path');

const TIMEOUT = 15000;
const AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 HotNewsBot';

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

// 硅基流动 AI 简介: Qwen3.5-9B
async function aiSummarize(repos, sfKey) {
  if (!sfKey) { console.log('   [AI] 跳过: 无 SILICONFLOW_KEY'); return repos; }
  const results = [];
  for (const repo of repos) {
    const prompt = `GitHub仓库: ${repo.full_name}\n描述: ${repo.description || '(无)'}\n\n用中文一句话30字内说清这个项目是做什么的，直接输出不要标点引号。`;
    try {
      const r = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${sfKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'Qwen/Qwen3.5-9B', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 60 })
      });
      const j = await r.json();
      const summary = (j.choices?.[0]?.message?.content || '').trim();
      results.push({ ...repo, summary });
      process.stdout.write('.');
    } catch (e) {
      results.push({ ...repo, summary: '' });
      process.stdout.write('x');
    }
    await new Promise(r => setTimeout(r, 600));
  }
  console.log(` [AI ${results.filter(r => r.summary).length}/${repos.length} OK]`);
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

async function fetchGithub(sfKey) {
  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const html = await get(`https://api.github.com/search/repositories?q=created:>=${weekAgo}&sort=stars&order=desc&per_page=15`, { Accept: 'application/vnd.github+json' });
    const j = JSON.parse(html);
    const repos = (j.items || []).map((it) => ({
      full_name: it.full_name, description: it.description || '',
      stars: it.stargazers_count, url: it.html_url || '', language: it.language || '',
    }));
    const enriched = await aiSummarize(repos, sfKey);
    return enriched.map((it) => ({
      title: it.summary ? `**${it.full_name} —— ${it.summary}**` : it.full_name,
      hot: `⭐ ${it.stars}`, url: it.url, source: 'github', tag: it.language, summary: it.summary,
    }));
  } catch (e) { console.log('   GitHub 失败:', e.message); return []; }
}

async function main() {
  const sfKey = process.env.SILICONFLOW_KEY;
  console.log('🚀 开始抓取中文热榜 + GitHub AI 简介...');
  console.log(`   AI: Qwen3.5-9B ${sfKey ? '(启用)' : '(未启用)'}\n`);

  const now = new Date().toISOString();
  const results = { updatedAt: now, source: 'live' };

  // 并行抓三个中文源
  await Promise.allSettled([
    fetchWeibo().then(d => { results.weibo = d; console.log(`   🔥 微博: ${d.length}`); }),
    fetchBaidu().then(d => { results.baidu = d; console.log(`   🔍 百度: ${d.length}`); }),
    fetchDouyin().then(d => { results.douyin = d; console.log(`   🎵 抖音: ${d.length}`); }),
  ]);

  // GitHub 串行（要调 AI）
  results.github = await fetchGithub(sfKey);
  console.log(`   ⭐ GitHub: ${results.github.length}`);

  const platforms = ['weibo', 'baidu', 'douyin', 'github'];
  for (const p of platforms) {
    if (!results[p] || results[p].length === 0) results[p] = [{ title: '暂无数据', source: p }];
  }

  const total = platforms.reduce((s, p) => s + results[p].length, 0);
  console.log(`\n✅ 总计 ${total} 条`);

  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'hot-news.json'), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(dataDir, 'hot-news.min.json'), JSON.stringify(results));
  for (const p of platforms) {
    fs.writeFileSync(path.join(dataDir, `${p}.json`), JSON.stringify({ data: results[p], updatedAt: now }, null, 2));
  }
  fs.writeFileSync(path.join(dataDir, 'update-time.txt'), now);
  console.log('✅ 已写入 data/');
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });