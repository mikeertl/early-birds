#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required to run the local server." >&2
  exit 1
fi

exec node - "${1-}" <<'JS'
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const automaticPort = process.argv[2] === '';
let port = automaticPort ? 8000 : Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Usage: ./go.sh [port] (1–65535; default 8000)');
  process.exit(1);
}

const root = process.cwd();
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const parts = pathname.split('/');
    // Keep repository metadata and hidden files out of the preview.
    if (parts.some(part => part.startsWith('.'))) {
      response.writeHead(404).end('Not found');
      return;
    }
    const filename = path.join(root, pathname === '/' ? 'index.html' : pathname);
    const real = await fs.realpath(filename);
    if (!real.startsWith(root + path.sep) || !(await fs.stat(real)).isFile()) {
      response.writeHead(404).end('Not found');
      return;
    }
    const content = await fs.readFile(real);
    response.writeHead(200, {
      'Content-Type': types[path.extname(real)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': content.length,
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    response.writeHead(error instanceof URIError ? 400 : 404).end('Not found');
  }
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE' && automaticPort && port < 8020) {
    console.log(`Port ${port} is busy; trying ${port + 1}…`);
    port += 1;
    server.listen(port, '127.0.0.1');
    return;
  }
  console.error(`Could not start server: ${error.message}`);
  if (error.code === 'EADDRINUSE') {
    console.error('Choose another port, for example: ./go.sh 8021');
  }
  process.exit(1);
});
server.on('listening', () => {
  console.log(`Early Birds Tennis: http://localhost:${port}`);
  console.log('Refresh your browser after edits. Press Ctrl+C to stop.');
});
server.listen(port, '127.0.0.1');
JS
