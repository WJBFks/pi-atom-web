#!/usr/bin/env node
/**
 * pi-atom-web 网关：固定端口 + 按 `/<会话短码>/` 前缀路由到各个 pi 进程。
 *
 * 为什么需要它：一个端口同一时刻只能被一个进程 listen，而用户要的是
 *   http://<ip>:31359/ab561/、http://<ip>:31359/11ad8/
 * 即多个 pi 进程共用一个端口、按路径区分会话。于是第一个执行 /web 的进程把本网关
 * 拉起来，各 pi 进程继续只监听 127.0.0.1 的私有随机端口，把 `{id -> 私有端口}` 注册进来，
 * 网关再把 `/<id>/*` 原样转发（含 SSE 流式响应）。
 *
 * 生命周期（用户 2026-09-25 明确要求，改动前先读这段）：
 *   1. 由第一个 /web 或 /web-wlan 创建（pi 侧 detached + unref 拉起）。
 *   2. **它不属于任何一个 pi 进程**：所以「会话 A 退出」绝不能带走「会话 B 的页面」。
 *      具体保证两条：a) 它是 detached 的独立进程，父进程退出不会被连带杀掉；
 *      b) 它不提供任何「关停」指令 —— 进程只能注销自己的路由，不能关停网关。
 *   3. 唯一的退出条件是路由表连续 idleMs 没有任何条目（即所有 pi 进程都退出或注销了）。
 *
 * 路由表只在内存里、靠心跳续命，**不落盘**：id 由 sessionId 稳定派生（见 gateway-client.ts），
 * 网关被杀掉后各 pi 进程的心跳会发现它没了、重新拉起并重新注册，同一张表自动复原。
 *
 * 控制接口只接受回环地址，且注册/注销要带启动密钥（`~/.pi/atom/web/gateway-<端口>.key`，0600），
 * 避免本机任意进程随便抢一个路径前缀。
 */
import { createServer, request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const GATEWAY_VERSION = 1;
/*
 * 会话地址失效时的等待页（用户 2026-09-30：页面常常开在**另一台机器**上，那里的人
 * 回不到 TUI 执行 /web，所以「等一会自己接回来」必须发生在浏览器这一侧）。
 * 短码不认账分两种：pi 正在启动 / 心跳窗口里（重试能救），以及 pi 真的没在跑
 * （等不到，所以超时后要停下来给结论，不能永远转圈）。
 */
const WAIT_RETRY_SECONDS = 3;
const WAIT_TIMEOUT_MS = 180000;
// 等待页计时用的查询名（会话短码不能以 __ 开头，所以不会跟路由撞车）。
const WAIT_PARAM = "__wait";

// 两种写法都支持：`--port=31359` 与 `--port 31359`（接入层用的是后者，只认等号会当场起不来）。
function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const match = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(argv[index]);
    if (!match) continue;
    const next = argv[index + 1];
    if (match[2] !== undefined) out[match[1]] = match[2];
    else if (next !== undefined && !next.startsWith("--")) {
      out[match[1]] = next;
      index += 1;
    } else out[match[1]] = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const host = args.host || "127.0.0.1";
const port = Number(args.port || 31359);
// 与 server.ts 的约定一致：绑 0.0.0.0 就是局域网模式，不校验 Host/Origin（凭证是唯一凭据）。
const lan = host !== "127.0.0.1";
// 一条路由连续多少秒没有任何动静（心跳或转发请求）就当作那个进程已经没了。
const ttlMs = Number(args.ttl || 90000);
// 路由表空多久之后自己退出。
const idleMs = Number(args.idle || 60000);
const keyFile =
  typeof args.key === "string" && args.key
    ? args.key
    : join(homedir(), ".pi", "atom", "web", `gateway-${port}.key`);
const healthPath = "/__atom/health";
const registerPath = "/__atom/register";
const unregisterPath = "/__atom/unregister";
const ID_PATTERN = /^[a-z0-9]{3,16}$/;
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function log(...parts) {
  if (args.verbose) console.log("[atom-gateway]", ...parts);
}

// 注册密钥：第一个启动者写，之后所有 pi 进程（含网关重启后的新网关）复用同一份，
// 这样 pi 侧不需要在每次网关重生时重新协商。
function readKey() {
  try {
    const current = readFileSync(keyFile, "utf8").trim();
    if (/^[a-f0-9]{32,128}$/i.test(current)) return current;
  } catch {
    // 不存在或读不到，往下创建
  }
  const created = randomBytes(32).toString("hex");
  mkdirSync(join(keyFile, ".."), { recursive: true });
  writeFileSync(keyFile, created, { mode: 0o600 });
  return created;
}

const key = readKey();
/** id -> { port, pid, seen } */
const routes = new Map();

function isLoopback(socket) {
  const address = socket.remoteAddress || "";
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address.startsWith("::ffff:127.")
  );
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) =>
    ch === "&"
      ? "&amp;"
      : ch === "<"
        ? "&lt;"
        : ch === ">"
          ? "&gt;"
          : ch === '"'
            ? "&quot;"
            : "&#39;",
  );
}

/** 只有浏览器直接导航才算文档请求；fetch / EventSource / 资源仍旧拿 JSON。 */
function wantsHtml(req) {
  return /text\/html/i.test(req.headers.accept || "");
}

/**
 * 短码不在路由表里时给浏览器的等待页（503 + `Retry-After`）。
 *
 * 重试用 `<meta http-equiv="refresh">` 而不是脚本 —— 这页的 CSP 只放 `style-src`，
 * 所以页面里一个字节脚本都没有；起始时间戳由查询参数带回来，超时判断完全在服务端做。
 * 非文档请求（API、SSE、静态资源）不进这里，仍旧返回原来的 404 JSON。
 */
function waitingPage(res, id, url) {
  const startedRaw = Number(url.searchParams.get(WAIT_PARAM));
  const started =
    Number.isFinite(startedRaw) && startedRaw > 0 ? startedRaw : Date.now();
  const waited = Date.now() - started;
  const overdue = waited > WAIT_TIMEOUT_MS;
  const search = new URLSearchParams(url.search);
  search.delete(WAIT_PARAM);
  const query = search.toString();
  const base = `/${encodeURIComponent(id)}/${query ? `?${query}` : ""}`;
  const target = overdue
    ? base
    : `${base}${base.includes("?") ? "&" : "?"}${WAIT_PARAM}=${started}`;
  const body = overdue
    ? `<p>地址 <code>/${escapeHtml(id)}/</code> 已经等了 ${Math.round(
        waited / 1000,
      )} 秒，那条 Pi 会话不在运行。</p>`
    : [
        `<p>地址 <code>/${escapeHtml(
          id,
        )}/</code> 现在没有对应的 Pi 会话在运行：可能正在启动，也可能心跳还没续上。</p>`,
        `<p>每 ${WAIT_RETRY_SECONDS} 秒自动重试一次，最长 ${Math.round(
          WAIT_TIMEOUT_MS / 60000,
        )} 分钟。</p>`,
        `<meta http-equiv="refresh" content="${WAIT_RETRY_SECONDS};url=${escapeHtml(
          target,
        )}">`,
      ].join("");
  res.writeHead(503, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Retry-After": String(WAIT_RETRY_SECONDS),
    // 没有脚本：只允许这页自己的内联样式。
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
  });
  res.end(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
      `<title>会话不在线</title>` +
      `<meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
      `<body style="font:14px/1.7 ui-monospace,Consolas,monospace;padding:24px;max-width:46em">` +
      body +
      (overdue
        ? `在那台机器上把会话开起来（Web 会跟着自动恢复）后，<a href="${escapeHtml(
            target,
          )}">点这里再试一次</a>。`
        : `<p style="color:#777">不需要回到终端执行命令：这条地址会自己接回来。</p>`) +
      `</body></html>`,
  );
}

function json(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 4096) reject(new Error("请求体过大"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

// 转发一条请求到某个 pi 进程的私有端口；SSE 必须逐块直透，不能聚合。
function forward(req, res, route, id, targetPath) {
  let clientClosed = false;
  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port: route.port,
      method: req.method,
      path: targetPath,
      agent: false,
      // host 换成上游自己的地址：上游服务对回环模式会校验 Host/Origin。
      headers: {
        ...req.headers,
        host: `127.0.0.1:${route.port}`,
        "x-forwarded-prefix": `/${id}`,
        "x-forwarded-host": req.headers.host || "",
        "x-atom-gateway": String(GATEWAY_VERSION),
      },
    },
    (upstreamResponse) => {
      if (clientClosed || res.destroyed) { upstreamResponse.destroy(); return; }
      const headers = {};
      for (const [name, value] of Object.entries(upstreamResponse.headers))
        if (!HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value;
      res.writeHead(upstreamResponse.statusCode || 502, headers);
      // SSE 依赖立即发出响应头，不能等第一块正文。
      res.flushHeaders();
      upstreamResponse.pipe(res);
      upstreamResponse.on("error", () => res.destroy());
    },
  );
  upstream.setTimeout(0);
  upstream.on("error", () => {
    // 浏览器取消监听/请求不是宿主退出；旧请求更不能摘掉 /reload 后的新路由。
    // 暂时连接失败保留租约，只有显式注销或 Pi 注册心跳过期才移除路由。
    if (clientClosed || req.aborted || res.destroyed) return;
    if (!res.headersSent)
      json(res, 502, { error: "暂时无法连接该会话的 Pi 服务，可能正在 /reload；请稍后重试，持续失败时在对应 TUI 执行 /web。" });
    else res.destroy();
  });
  req.pipe(upstream);
  req.on("aborted", () => { clientClosed = true; upstream.destroy(); });
  res.on("close", () => { clientClosed = true; upstream.destroy(); });
}

function indexPage(res) {
  const items = [...routes.keys()].sort();
  const rows = items
    .map((id) => `<li><a href="/${id}/">/${id}/</a></li>`)
    .join("");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
  });
  res.end(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>pi-atom-web 网关</title>` +
      `<body style="font:14px/1.6 ui-monospace,Consolas,monospace;padding:24px">` +
      `<p>pi-atom-web 网关 · 端口 ${port} · 在某个会话的 TUI 里执行 /web 拿到带凭证的完整地址。</p>` +
      (rows ? `<ul>${rows}</ul>` : "<p>当前没有已注册的会话。</p>") +
      `</body></html>`,
  );
}

const server = createServer(async (req, res) => {
  const reply = () => {
    try {
      return new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    } catch {
      return null;
    }
  };
  const url = reply();
  if (!url) return json(res, 400, { error: "非法请求行" });
  const path = url.pathname;

  // 回环网关保留 Host 校验（等价于服务自己的那道防线，挡住 DNS rebinding）；
  // 局域网网关按既有约定不校验，凭证是唯一凭据。
  if (!lan) {
    const hostname = url.hostname;
    if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]")
      return json(res, 403, { error: "该网关只监听本机" });
  }

  try {
    if (req.method === "GET" && path === healthPath)
      return json(res, 200, {
        app: "pi-atom-web-gateway",
        version: GATEWAY_VERSION,
        lan,
        port,
        routes: routes.size,
      });

    if (path === registerPath || path === unregisterPath) {
      if (!isLoopback(req.socket))
        return json(res, 403, { error: "只接受本机注册" });
      if (req.headers["x-atom-key"] !== key)
        return json(res, 403, { error: "注册密钥不匹配" });
      if (req.method !== "POST") return json(res, 405, { error: "只支持 POST" });
      const body = await readBody(req);
      const id = String(body.id || "");
      if (!ID_PATTERN.test(id)) return json(res, 400, { error: "非法会话短码" });
      if (path === unregisterPath) {
        const current = routes.get(id);
        // 只注销自己那条：端口对不上说明已经被别的进程接管，不能误删。
        if (current && current.port === Number(body.port)) routes.delete(id);
        log("注销", id);
        return json(res, 200, { ok: true });
      }
      const privatePort = Number(body.port);
      if (!Number.isInteger(privatePort) || privatePort <= 0 || privatePort > 65535)
        return json(res, 400, { error: "私有端口非法" });
      const current = routes.get(id);
      // 同 pid = 同一个 pi 进程（/reload 换了私有端口）；无主 = 新会话。
      // 不同 pid 抢同一个短码 = 两个进程打开了同一个会话，让后来者换个后缀。
      if (current && current.port !== privatePort && current.pid !== Number(body.pid))
        return json(res, 409, { error: "会话短码已被占用", suggest: suggest(id) });
      routes.set(id, {
        port: privatePort,
        pid: Number(body.pid) || 0,
        seen: Date.now(),
      });
      log("注册", id, "->", privatePort);
      return json(res, 200, { ok: true, id, replaced: Boolean(current) });
    }

    if (req.method === "GET" && (path === "/" || path === "")) {
      // 首页只在回环网关上列会话，局域网模式下不对外暴露会话清单。
      if (lan) return json(res, 404, { error: "缺少会话路径" });
      return indexPage(res);
    }
    if (req.method === "GET" && path === "/favicon.ico") {
      res.writeHead(204, { "Cache-Control": "public, max-age=86400" });
      return res.end();
    }

    const match = /^\/([^/]+)(\/[\s\S]*)?$/.exec(path);
    const id = match?.[1] || "";
    if (!id || id.startsWith("__"))
      return json(res, 404, { error: "未知会话路径" });
    if (!match[2]) {
      // 前端资源用的是相对地址，目录形式（结尾斜杠）才能解析到 /<id>/ 下面；
      // 查询串一并带上，别在跳转这一步把它丢了。
      res.writeHead(302, {
        Location: `/${id}/${url.search}`,
        "Cache-Control": "no-store",
      });
      return res.end();
    }
    const route = routes.get(id);
    if (!route) {
      // 浏览器直接刷这个地址 → 给会自动重试的等待页（远程打开的人回不到 TUI）；
      // API / SSE / 资源仍旧是 404 JSON，免得前端把 HTML 当成快照解析。
      if (req.method === "GET" && wantsHtml(req))
        return waitingPage(res, id, url);
      return json(res, 404, {
        error:
          "没有这个会话地址（可能已退出，或正在启动后自动恢复）；用浏览器打开这个地址会自动重试。",
      });
    }
    // seen 仅由 Pi 注册心跳续期，浏览器轮询不能让失效路由永久存活。
    return forward(req, res, route, id, match[2] + url.search);
  } catch (error) {
    if (!res.headersSent) json(res, 500, { error: error.message });
    else res.end();
  }
});

function suggest(id) {
  for (let index = 2; index <= 9; index += 1) {
    const candidate = `${id.slice(0, 4)}${index}`;
    if (!routes.has(candidate)) return candidate;
  }
  return `${id}${Date.now().toString(36).slice(-2)}`;
}

// 转发用的连接不能带 Node 默认的请求超时，否则 SSE 会被掐断。
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 65000;

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, route] of routes)
    if (now - route.seen > ttlMs) {
      routes.delete(id);
      log("心跳超时，摘除", id);
    }
  if (routes.size) {
    lastBusy = now;
    return;
  }
  if (now - lastBusy > idleMs) {
    log("所有 pi 进程都已离开，网关退出");
    clearInterval(sweeper);
    server.close(() => process.exit(0));
    // 兜底：还有长连接（SSE）挂着时不强杀，等它们自己结束。
    setTimeout(() => process.exit(0), 5000).unref();
  }
}, 10000);
let lastBusy = Date.now();

server.on("error", (error) => {
  // 两个 pi 进程同时拉起网关时，输的那一方会撞上 EADDRINUSE —— 那不是错误，安静退出。
  if (error && error.code === "EADDRINUSE") process.exit(0);
  console.error(`pi-atom-web 网关启动失败：${error?.message || error}`);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`pi-atom-web 网关已监听 ${host}:${port}（局域网：${lan ? "是" : "否"}）`);
});
