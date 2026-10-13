/**
 * pi 侧的网关接入：端口配置、会话短码、拉起网关、注册与心跳。
 *
 * 固定端口 + `/<会话短码>/` 路由的实现分成两半：
 *   · `gateway.mjs` —— 真正 listen 固定端口的独立进程（不属于任何 pi 进程）；
 *   · 本文件 —— pi 进程这边：需要时把它拉起来、把自己的私有端口登记进去、靠心跳续命。
 *
 * 端口配置放在 `~/.pi/atom/web/config.json`（**用户级、所有 pi 进程共用**），因为拉起网关的
 * 是 pi 进程，浏览器 localStorage 里的偏好它读不到；设置页「会话 → 网关端口」通过
 * `configure_web` 动作改写它，改完下一次执行 /web 或 /web-wlan 才生效。
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_GATEWAY_PORT = 31359;
export const DEFAULT_GATEWAY_LAN_PORT = 31360;
const GATEWAY_FILE = fileURLToPath(new URL("./gateway.mjs", import.meta.url));
// 跟已有的「跨项目设置统一预留在 ~/.pi/atom/」约定对齐，网关部分集中在它的 web/ 子目录。
const CONFIG_DIR = join(homedir(), ".pi", "atom", "web");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
// 「这个会话上次显式开着 Web」的登记表（用户 2026-09-30：远程浏览器里的人回不到 TUI，
// 所以重启 pi 之后必须自己活回来）。只记显式执行过 /web、/web-wlan 的会话；
// `/web stop` 就是删条目（= 尊重“我把它关了”的意图，下次不自动开）。
const SESSIONS_FILE = join(CONFIG_DIR, "sessions.json");
// 超过这个没动过的条目不再自动恢复（免得半年前的会话永远赖在表里）。
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
// 固定凭证用的本机密钥（用户 2026-09-25 选定：本机密钥 + 会话 id 派生）。
// 密钥只存在这台机器上，删掉它就是所有固定凭证整体换代。
const TOKEN_KEY_FILE = join(CONFIG_DIR, "token.key");
// 心跳间隔必须显著小于网关的 ttlMs（默认 90s），否则路由会被误摘。
const HEARTBEAT_MS = 20000;

function normalizePort(value, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535)
    return fallback;
  return number;
}

/** 读用户级端口配置；文件缺失或损坏都退回默认值。 */
export function readWebConfig() {
  let stored = {};
  try {
    stored = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) || {};
  } catch {
    stored = {};
  }
  return {
    port: normalizePort(
      process.env.PI_ATOM_WEB_PORT ?? stored.port,
      DEFAULT_GATEWAY_PORT,
    ),
    lanPort: normalizePort(
      process.env.PI_ATOM_WEB_LAN_PORT ?? stored.lanPort,
      DEFAULT_GATEWAY_LAN_PORT,
    ),
    // 固定凭证（同一会话每次同一个 token）：默认关，仍用每次随机的 64 位十六进制。
    fixedToken: stored.fixedToken === true,
    // 自动恢复的全局总开关（默认开）：关掉后登记表再在也不自动起服务，
    // 只能手动 /web（用 `/web auto off` 改）。
    autoServe: stored.autoServe !== false,
  };
}

/**
 * 登记表：`{ [sessionId]: { mode: "loopback"|"lan", at } }`，只给自动恢复用。
 * 每次读都顺手丢掉超期与形状不对的条目，所以文件坏了也只会退回“不自动开”。
 */
function readSessions() {
  let stored = {};
  try {
    stored = JSON.parse(readFileSync(SESSIONS_FILE, "utf8")) || {};
  } catch {
    return {};
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  const now = Date.now();
  const fresh = {};
  for (const [id, value] of Object.entries(stored)) {
    const at = Number(value?.at);
    if (!Number.isFinite(at) || now - at > SESSION_TTL_MS) continue;
    const mode = value?.mode;
    if (mode !== "loopback" && mode !== "lan") continue;
    fresh[id] = { mode, at };
  }
  return fresh;
}

function writeSessions(sessions) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), { mode: 0o600 });
}

/** 本会话上次是不是显式开着 Web；总开关关着、或没登记过都返回 null。 */
export function autoServeMode(sessionId) {
  if (!readWebConfig().autoServe) return null;
  return readSessions()[String(sessionId)]?.mode || null;
}

/** 记下“本会话开着 Web”（/web 与 /web-wlan 启动成功后调）。 */
export function rememberWebSession(sessionId, mode) {
  const sessions = readSessions();
  sessions[String(sessionId)] = { mode, at: Date.now() };
  writeSessions(sessions);
}

/** 抹掉登记（`/web stop`）：下次启动不再自动恢复。 */
export function forgetWebSession(sessionId) {
  const sessions = readSessions();
  const id = String(sessionId);
  if (!(id in sessions)) return false;
  delete sessions[id];
  writeSessions(sessions);
  return true;
}

/**
 * 写用户级 Web 配置；两个端口不能相同。`fixedToken` 省略就是不改（只改端口不会把它关掉）。
 */
export function writeWebConfig({ port, lanPort, fixedToken, autoServe }) {
  const current = readWebConfig();
  const next = {
    port: normalizePort(port, current.port),
    lanPort: normalizePort(lanPort, current.lanPort),
    fixedToken:
      fixedToken === undefined ? current.fixedToken : Boolean(fixedToken),
    // 只改端口不会顺手把自动恢复关掉（与 fixedToken 同一规则）
    autoServe: autoServe === undefined ? current.autoServe : Boolean(autoServe),
  };
  if (next.port === next.lanPort)
    throw new Error("本机端口与局域网端口不能相同");
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

/** 本机密钥的路径（设置页要展示：删掉它 = 所有固定凭证换代）。 */
export function webTokenKeyPath() {
  return TOKEN_KEY_FILE;
}

/** 读本机密钥；不存在就生成一个（首次开启固定凭证时发生）。 */
export function readTokenKey() {
  try {
    const value = readFileSync(TOKEN_KEY_FILE, "utf8").trim();
    if (/^[a-f0-9]{32,128}$/i.test(value)) return value;
  } catch {
    /* 不存在，交给下面生成 */
  }
  return rotateTokenKey();
}

/** 换一个新密钥：所有会话的固定凭证随之换代（凭证泄露时的自救手段）。 */
export function rotateTokenKey() {
  const value = randomBytes(32).toString("hex");
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(TOKEN_KEY_FILE, value, { mode: 0o600 });
  return value;
}

/**
 * 固定凭证：sha256(本机密钥 : 会话 id) 的十六进制，正好 64 位，跟每次随机的那份同形状
 * （前端 `TOKEN_RE` 认的就是 64 位十六进制）。
 *
 * 掺进本机密钥是故意的：只用会话 id 派生的话，会话 id 泄露（会话文件名、日志、截图）
 * 就等于交出凭证；掺了只有本机才有的密钥后，光知道会话 id 算不出 token。
 */
export function deriveSessionToken(sessionId) {
  return createHash("sha256")
    .update(`${readTokenKey()}:${String(sessionId)}`)
    .digest("hex");
}

/**
 * 会话短码：sessionId 的 sha256 前 5 位十六进制。
 * 稳定（同一会话重开 / 重起 pi 进程都不变，可以收藏地址），又足够短好手打。
 * 两个进程打开同一会话会撞码，由网关返回 409 + suggest 让后来者换后缀。
 */
export function sessionShortCode(sessionId) {
  return createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 5);
}

export function publicUrl({ host, port, id, token }) {
  return `http://${host}:${port}/${id}/#${token}`;
}

function call(port, path, body, key, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: body === undefined ? "GET" : "POST",
        path,
        timeout: timeoutMs,
        headers: body
          ? {
              "Content-Type": "application/json",
              ...(key ? { "x-atom-key": key } : {}),
            }
          : undefined,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let value = {};
          try {
            value = JSON.parse(raw);
          } catch {
            /* 非 JSON 响应按空对象处理，由调用方看 status 判断 */
          }
          resolve({ status: res.statusCode || 0, value });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("网关无响应")));
    req.on("error", reject);
    if (body !== undefined) req.end(JSON.stringify(body));
    else req.end();
  });
}

async function healthy(port) {
  try {
    const { status, value } = await call(port, "/__atom/health", undefined, undefined, 600);
    return status === 200 && value?.app === "pi-atom-web-gateway";
  } catch {
    return false;
  }
}

function readKeySync(port) {
  const file = join(CONFIG_DIR, `gateway-${port}.key`);
  try {
    const value = readFileSync(file, "utf8").trim();
    if (/^[a-f0-9]{32,128}$/i.test(value)) return value;
  } catch {
    /* 不存在，交给下面等 */
  }
  return null;
}

// 网关刚被拉起来时密钥文件可能还没写好，轮询等它（不能卡住事件绕循环）。
async function readKey(port) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const value = readKeySync(port);
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`读不到网关密钥（${join(CONFIG_DIR, `gateway-${port}.key`)}）`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** TCP 能不能连上这个端口（连得上 = 有东西在听，不一定是我们的网关）。 */
function portListening(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * 确保固定端口上的网关在跑：先探活，探不到就 detached 拉起一个新的，再轮询探活。
 * 两个进程同时拉起时输的一方会撞 EADDRINUSE（网关自己安静退出），这里靠子进程退出事件发现。
 */
async function ensureGateway(port, lan) {
  if (await healthy(port)) return;
  const child = spawn(
    process.execPath,
    [GATEWAY_FILE, "--host", lan ? "0.0.0.0" : "127.0.0.1", "--port", String(port)],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  let exitCode = null;
  child.on("error", () => {});
  child.on("exit", (code) => {
    exitCode = code;
  });
  child.unref();
  // 探活永远排在报错前面：另一个 pi 进程刚抢先把网关拉起来时，这里只会多等几轮就成功。
  // 轮询上限 60×200ms = 12s：Windows 上新进程的 node 启动可能被安全软件拖到好几秒。
  let foreign = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await healthy(port)) return;
    // 端口有人听、回的却不是网关的探活：那是别人的服务。网关自己不可能 listen 上了却不认这条探活，
    // 所以连 3 次就能判定，不必等满 12s（默认端口被占的机器上，每次 /web 都会走到这里）。
    if (exitCode === null && (await portListening(port)) && ++foreign >= 3)
      throw new Error(
        `端口 ${port} 上坐着别的程序（不是 pi-atom-web 网关），请到「设置 → 会话 → 网关端口」换一对端口`,
      );
    if (exitCode === null) {
      await sleep(200);
      continue;
    }
    // 子进程退了（最常见是撞端口后安静退出）。再探一次活，确认不是“别人刚好接手”。
    if (await healthy(port)) return;
    throw new Error(
      (await portListening(port))
        ? `端口 ${port} 已被其它程序占用（不是 pi-atom-web 网关），请到「设置 → 会话 → 网关端口」换一对端口`
        : `网关进程异常退出（退出码 ${exitCode}）`,
    );
  }
  // 子进程还活着却始终探不到活（启动超慢或卡住）：必须报错，否则下一步注册会给出莫名其妙的失败。
  throw new Error(
    (await portListening(port))
      ? `端口 ${port} 上没有可用的 pi-atom-web 网关（可能已被其它程序占用），请到「设置 → 会话 → 网关端口」换一对端口`
      : `网关（端口 ${port}）启动超时，检查端口是否被别的程序占用`,
  );
}

/**
 * 把本进程登记进网关，并开始心跳。返回最终短码与停止函数。
 *
 * 心跳除了续命还负责**接管**：网关被杀掉后，探活失败会重新拉起并重新登记，
 * 于是短码不变、端口不变，浏览器靠 SSE 看门狗自动重连就恢复了 —— 用户选的就是这个档。
 */
export async function attachGateway({ lan, sessionId, privatePort, preferredId }) {
  const { port, lanPort } = readWebConfig();
  const gatewayPort = lan ? lanPort : port;
  await ensureGateway(gatewayPort, lan);
  const key = await readKey(gatewayPort);
  let id = preferredId || sessionShortCode(sessionId);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const { status, value } = await call(
      gatewayPort,
      "/__atom/register",
      { id, port: privatePort, pid: process.pid },
      key,
    );
    if (status === 200) break;
    if (status === 409 && value?.suggest) {
      id = String(value.suggest);
      continue;
    }
    throw new Error(value?.error || `注册失败（HTTP ${status}）`);
  }
  let stopped = false;
  let timer;
  const heartbeat = async () => {
    if (stopped) return;
    try {
      const { status } = await call(
        gatewayPort,
        "/__atom/register",
        { id, port: privatePort, pid: process.pid },
        key,
      );
      if (status === 200) return;
    } catch {
      /* 网关大概死了，下面重新拉起 */
    }
    if (stopped) return;
    try {
      await ensureGateway(gatewayPort, lan);
      await call(
        gatewayPort,
        "/__atom/register",
        { id, port: privatePort, pid: process.pid },
        readKeySync(gatewayPort) || key,
      );
    } catch {
      /* 下一轮心跳再试 */
    }
  };
  timer = setInterval(heartbeat, HEARTBEAT_MS);
  timer.unref?.();
  return {
    id,
    port: gatewayPort,
    lan,
    async stop() {
      stopped = true;
      clearInterval(timer);
      // 只注销自己这一条路由：关停网关不在任何进程的能力范围内。
      try {
        await call(
          gatewayPort,
          "/__atom/unregister",
          { id, port: privatePort },
          key,
        );
      } catch {
        /* 网关已经先退出了，路由会自己超时 */
      }
    },
  };
}
