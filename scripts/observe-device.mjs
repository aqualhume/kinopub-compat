// Observation relay for a real device. Sits in front of a running server on its
// own port; the device connects here instead. Reports what that device actually
// fetched, so claims about transfer size and caching can be checked on hardware
// rather than in emulation.
//
//   npm start                     # terminal 1, the app on :3000
//   node scripts/observe-device.mjs   # terminal 2, relay on :3001
//
// Open the printed LAN address on the iPad, browse, then press Enter here.
//
// Paths are recorded without query strings, and no header values, cookies, or
// bodies are stored, so signed media links and session data stay out of the
// report. Nothing is written to disk.
import http from 'node:http';
import { networkInterfaces } from 'node:os';

const target = process.env.TARGET || 'http://127.0.0.1:3000';
const port = Number(process.env.PORT || 3001);
const targetURL = new URL(target);
const records = [];

// Query strings carry signed manifest payloads and search terms, so only the
// path is kept. Long media paths collapse to a single label.
function label(pathname) {
  if (pathname.startsWith('/__local/media/')) return '/__local/media/<signed>';
  return pathname.length > 60 ? pathname.slice(0, 57) + '...' : pathname;
}

const relay = http.createServer((req, res) => {
  const started = process.hrtime.bigint();
  const path = new URL(req.url, 'http://x').pathname;
  const upstream = http.request({
    protocol: targetURL.protocol, hostname: targetURL.hostname, port: targetURL.port,
    method: req.method, path: req.url,
    headers: { ...req.headers, host: targetURL.host }
  }, response => {
    let bytes = 0;
    response.on('data', chunk => { bytes += chunk.length; });
    response.on('end', () => {
      records.push({
        method: req.method,
        path: label(path),
        status: response.statusCode,
        encoding: response.headers['content-encoding'] || 'none',
        declared: Number(response.headers['content-length'] || 0),
        bytes,
        cached: response.statusCode === 304,
        ms: Number(process.hrtime.bigint() - started) / 1e6,
        agent: /iPad|iPhone/.test(req.headers['user-agent'] || '') ? 'ios' : 'other',
        accepts: /\bbr\b/.test(req.headers['accept-encoding'] || '') ? 'br' : (/gzip/.test(req.headers['accept-encoding'] || '') ? 'gzip' : 'none')
      });
    });
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
  req.pipe(upstream);
});

function report() {
  const device = records.filter(r => r.agent === 'ios');
  const rows = device.length ? device : records;
  if (!rows.length) { console.log('\nNo requests recorded. Did the device load the relay address?'); return; }
  console.log(`\n${rows.length} requests${device.length ? ' from an iPad or iPhone' : ' (no iOS user agent seen)'}\n`);
  console.log('  status  enc     wire      ms   path');
  for (const r of rows) {
    console.log(`  ${String(r.status).padEnd(7)}${r.encoding.padEnd(8)}${((r.bytes / 1024).toFixed(1) + 'KB').padStart(8)}${r.ms.toFixed(0).padStart(6)}   ${r.path}`);
  }
  const total = rows.reduce((sum, r) => sum + r.bytes, 0);
  const revalidated = rows.filter(r => r.cached).length;
  const compressed = rows.filter(r => r.encoding !== 'none').length;
  const mismatched = rows.filter(r => r.declared && r.declared !== r.bytes && !r.cached);
  console.log(`\n  total transferred : ${(total / 1024).toFixed(0)}KB`);
  console.log(`  compressed        : ${compressed}/${rows.length}`);
  console.log(`  revalidated (304) : ${revalidated}`);
  console.log(`  encodings offered : ${[...new Set(rows.map(r => r.accepts))].join(', ')}`);
  if (mismatched.length) {
    console.log(`\n  WARNING: ${mismatched.length} response(s) sent a byte count different from content-length:`);
    for (const r of mismatched) console.log(`    ${r.path} declared ${r.declared} sent ${r.bytes}`);
  }
  const media = rows.filter(r => r.path.includes('/media/'));
  if (media.length) {
    const encoded = media.filter(r => r.encoding !== 'none');
    console.log(`\n  media segments    : ${media.length}, ${encoded.length ? 'RECOMPRESSED (unexpected)' : 'passed through uncompressed'}`);
  }
}

relay.listen(port, '0.0.0.0', () => {
  console.log(`Relay on :${port} -> ${target}`);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) console.log(`  open on the iPad: http://${address.address}:${port}`);
    }
  }
  console.log('\nBrowse on the device, then press Enter for the report.');
  process.stdin.once('data', () => { report(); relay.close(); process.exit(0); });
});
