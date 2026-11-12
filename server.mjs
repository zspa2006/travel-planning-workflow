import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/styles.css', ['styles.css', 'text/css']],
  ...['app', 'api', 'demo', 'preview'].map(name => [
    '/'+name+'.mjs', [name+'.mjs', 'text/javascript']
  ])
]);

const port = Number(process.env.PORT ?? 4173);
createServer(async (req, res) => {
  const asset = assets.get(req.url.split('?')[0]);
  if (!asset || !['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(asset ? 405 : 404).end();
    return;
  }
  try {
    const [file, type] = asset;
    const body = await readFile(new URL('frontend/'+file, import.meta.url));
    res.writeHead(200, { 'Content-Type': type+'; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(500).end('Unable to load frontend asset');
  }
}).listen(port, '127.0.0.1', () => console.log('http://127.0.0.1:'+port));
