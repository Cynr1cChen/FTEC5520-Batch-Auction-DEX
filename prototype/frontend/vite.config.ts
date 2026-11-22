import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { Plugin, ViteDevServer } from 'vite';
import { defineConfig } from 'vite';

const execFileAsync = promisify(execFile);
const frontendDir = path.dirname(fileURLToPath(import.meta.url));
const prototypeDir = path.resolve(frontendDir, '..');
const deploymentPath = path.join(prototypeDir, 'runtime', 'deployment.json');
const demoEnvScript = path.join(prototypeDir, 'demo-env');

function sendJson(res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (b: string) => void }, status: number, payload: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function runtimeDemoPlugin(): Plugin {
  const attach = (server: ViteDevServer) => {
    server.middlewares.use('/api/deployment', async (req, res, next) => {
      if (req.method !== 'GET') return next();
      try {
        const raw = await readFile(deploymentPath, 'utf8');
        sendJson(res, 200, { ok: true, manifest: JSON.parse(raw) });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'ENOENT') {
          sendJson(res, 404, { ok: false, error: 'not_deployed', message: '未检测到 prototype/runtime/deployment.json，请先启动节点并部署合约。' });
        } else {
          sendJson(res, 500, { ok: false, error: (err as Error).message });
        }
      }
    });

    server.middlewares.use('/api/reset', async (req, res, next) => {
      if (req.method !== 'POST') return next();
      try {
        const { stdout, stderr } = await execFileAsync(demoEnvScript, ['demo:reset'], {
          cwd: prototypeDir,
          env: process.env,
          timeout: 30000,
        });
        const raw = await readFile(deploymentPath, 'utf8');
        sendJson(res, 200, { ok: true, manifest: JSON.parse(raw), output: stdout.trim() || stderr.trim() });
      } catch (err) {
        const e = err as { stderr?: string; stdout?: string; message?: string };
        sendJson(res, 500, {
          ok: false,
          error: (e.stderr || e.stdout || e.message || 'Reset failed').trim(),
        });
      }
    });

    server.middlewares.use('/api/deploy', async (req, res, next) => {
      if (req.method !== 'POST') return next();
      try {
        const { stdout, stderr } = await execFileAsync(demoEnvScript, ['demo:deploy', '--variants'], {
          cwd: prototypeDir,
          env: process.env,
          timeout: 90000,
        });
        const raw = await readFile(deploymentPath, 'utf8');
        sendJson(res, 200, { ok: true, manifest: JSON.parse(raw), output: stdout.trim() || stderr.trim() });
      } catch (err) {
        const e = err as { stderr?: string; stdout?: string; message?: string };
        sendJson(res, 500, {
          ok: false,
          error: (e.stderr || e.stdout || e.message || 'Deploy failed').trim(),
        });
      }
    });
  };

  return {
    name: 'ftec5520-runtime-demo',
    configureServer: attach,
  };
}

const rpcTarget = process.env.FTEC5520_RPC_URL || 'http://127.0.0.1:8545';

export default defineConfig({
  plugins: [react(), tailwindcss(), runtimeDemoPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    fs: {
      allow: [frontendDir, prototypeDir],
    },
    proxy: {
      '/rpc': {
        target: rpcTarget,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/rpc/, '') || '/',
      },
    },
  },
});
