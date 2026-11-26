#!/usr/bin/env node
/**
 * tests/serve.js
 * Tiny static file server with no dependencies.
 *
 * Why it exists: the extension's content script only runs on http:// and
 * https:// pages, so the test pages cannot be opened as file:// URLs.
 *
 * Use from the command line:
 *   node tests/serve.js                 serves test-sites/ on http://127.0.0.1:4173
 *   node tests/serve.js --port 5000     different port
 *   node tests/serve.js --root tests/fixtures
 *
 * Use from code:
 *   const { startServer } = require('./serve');
 *   const server = await startServer({ root, port });   // server.url, server.close()
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ROOT = path.join(REPO_ROOT, 'test-sites');
const DEFAULT_PORT = 4173;
const HOST = '127.0.0.1'; // local machine only, never exposed to the network

// File extension -> Content-Type header.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
};

/**
 * Start the server.
 * @param {object} [opts]
 * @param {string} [opts.root] directory to serve (default: test-sites/)
 * @param {number} [opts.port] port to listen on (default 4173; 0 = any free port)
 * @returns {Promise<{url:string, port:number, root:string, close:()=>Promise<void>}>}
 */
function startServer(opts = {}) {
  const root = path.resolve(opts.root || DEFAULT_ROOT);
  const port = opts.port === undefined ? DEFAULT_PORT : opts.port;

  const server = http.createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, `http://${HOST}`).pathname);
    } catch (e) {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }

    // Resolve inside the root and refuse anything that escapes it (../ tricks).
    let filePath = path.join(root, path.normalize(urlPath));
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.stat(filePath, (err, stat) => {
      if (!err && stat.isDirectory()) {
        // Redirect /dir to /dir/ so relative links inside the page resolve.
        if (!urlPath.endsWith('/')) {
          res.writeHead(301, { Location: urlPath + '/' });
          res.end();
          return;
        }
        filePath = path.join(filePath, 'index.html');
      }
      fs.readFile(filePath, (readErr, body) => {
        if (readErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`Not found: ${urlPath}`);
          return;
        }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store', // always serve the latest file from disk
        });
        res.end(body);
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      const actualPort = server.address().port;
      resolve({
        url: `http://${HOST}:${actualPort}`,
        port: actualPort,
        root,
        close: () => new Promise((done) => {
          server.closeAllConnections && server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}

module.exports = { startServer, DEFAULT_PORT, DEFAULT_ROOT, HOST };

// Run directly: parse --port / --root and keep serving until Ctrl+C.
if (require.main === module) {
  const args = process.argv.slice(2);
  const valueOf = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const port = valueOf('--port') ? Number(valueOf('--port')) : DEFAULT_PORT;
  const root = valueOf('--root') || DEFAULT_ROOT;
  startServer({ root, port })
    .then((s) => console.log(`Serving ${s.root}\n  at ${s.url}/\nPress Ctrl+C to stop.`))
    .catch((e) => {
      console.error(`Could not start the server: ${e.message}`);
      if (e.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Try: node tests/serve.js --port 4174`);
      process.exit(1);
    });
}
