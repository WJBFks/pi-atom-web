import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import {
  validateAction,
  validateServerEvent,
} from "../shared/protocol.ts";

const assets = new Map([
  ["/", ["../web/index.html", "text/html"]],
  [
    "/xterm.js",
    ["../node_modules/@xterm/xterm/lib/xterm.js", "text/javascript"],
  ],
  ["/xterm.css", ["../node_modules/@xterm/xterm/css/xterm.css", "text/css"]],
  ["/style.css", ["../web/style.css", "text/css"]],
  ["/fonts.css", ["../web/fonts.css", "text/css"]],
  [
    "/fonts/noto-sans-mono-latin.woff2",
    [
      "../node_modules/@fontsource-variable/noto-sans-mono/files/noto-sans-mono-latin-wght-normal.woff2",
      "font/woff2",
    ],
  ],
  [
    "/fonts/noto-sans-mono-latin-ext.woff2",
    [
      "../node_modules/@fontsource-variable/noto-sans-mono/files/noto-sans-mono-latin-ext-wght-normal.woff2",
      "font/woff2",
    ],
  ],
  [
    "/fonts/noto-sans-mono-vietnamese.woff2",
    [
      "../node_modules/@fontsource-variable/noto-sans-mono/files/noto-sans-mono-vietnamese-wght-normal.woff2",
      "font/woff2",
    ],
  ],
  [
    "/fonts/noto-sans-mono-greek.woff2",
    [
      "../node_modules/@fontsource-variable/noto-sans-mono/files/noto-sans-mono-greek-wght-normal.woff2",
      "font/woff2",
    ],
  ],
  [
    "/fonts/noto-sans-mono-greek-ext.woff2",
    [
      "../node_modules/@fontsource-variable/noto-sans-mono/files/noto-sans-mono-greek-ext-wght-normal.woff2",
      "font/woff2",
    ],
  ],
  [
    "/fonts/noto-sans-mono-cyrillic.woff2",
    [
      "../node_modules/@fontsource-variable/noto-sans-mono/files/noto-sans-mono-cyrillic-wght-normal.woff2",
      "font/woff2",
    ],
  ],
  [
    "/fonts/noto-sans-mono-cyrillic-ext.woff2",
    [
      "../node_modules/@fontsource-variable/noto-sans-mono/files/noto-sans-mono-cyrillic-ext-wght-normal.woff2",
      "font/woff2",
    ],
  ],
  [
    "/marked.js",
    ["../node_modules/marked/lib/marked.umd.js", "text/javascript"],
  ],
  [
    "/purify.js",
    ["../node_modules/dompurify/dist/purify.min.js", "text/javascript"],
  ],
  [
    "/highlight.js",
    [
      "../node_modules/@highlightjs/cdn-assets/highlight.min.js",
      "text/javascript",
    ],
  ],
  ["/shared/protocol.js", ["../shared/protocol.js", "text/javascript"]],
]);

async function browserAssets(
  root,
  publicPrefix,
  directory = root,
  relativePrefix = "",
) {
  const files = await readdir(directory, { withFileTypes: true });
  const assets = new Map();
  for (const file of files) {
    const relative = `${relativePrefix}${file.name}`;
    if (file.isDirectory()) {
      for (const [path, target] of await browserAssets(
        root,
        publicPrefix,
        new URL(`${file.name}/`, directory),
        `${relative}/`,
      ))
        assets.set(path, target);
    } else if (
      file.isFile() &&
      (file.name.endsWith(".js") || file.name.endsWith(".css"))
    ) {
      assets.set(`/${publicPrefix}${relative}`, [
        new URL(relative, root),
        file.name.endsWith(".css") ? "text/css" : "text/javascript",
      ]);
    }
  }
  return assets;
}

async function configuredAssets() {
  const configured = new Map(assets);
  for (const [path, target] of await browserAssets(
    new URL("../web/", import.meta.url),
    "",
  ))
    configured.set(path, target);
  configured.set("/vendor/vue.js", [
    "../node_modules/vue/dist/vue.runtime.esm-browser.prod.js",
    "text/javascript",
  ]);
  configured.set("/vendor/pinia.js", [
    "../node_modules/pinia/dist/pinia.esm-browser.js",
    "text/javascript",
  ]);
  configured.set("/vendor/vue-router.js", [
    "../node_modules/vue-router/dist/vue-router.esm-browser.prod.js",
    "text/javascript",
  ]);
  for (const [path, target] of await browserAssets(
    new URL("../node_modules/@vue/devtools-api/lib/esm/", import.meta.url),
    "vendor/devtools-api/",
  ))
    configured.set(path, target);
  return configured;
}

async function importMapHash() {
  const html = await readFile(
    new URL("../web/index.html", import.meta.url),
    "utf8",
  );
  const maps = [
    ...html.matchAll(
      /<script\s+type=["']importmap["']\s*>([\s\S]*?)<\/script>/gi,
    ),
  ];
  if (maps.length !== 1) return "";
  return `'sha256-${createHash("sha256").update(maps[0][1]).digest("base64")}'`;
}

// 无法从别的设备访问的地址：链路本地（169.254/16）与代理/TUN 常用的 fake-IP 段（198.18/15）。
const UNUSABLE_LAN_ADDRESS = [/^169\.254\./, /^198\.18\./, /^198\.19\./];
// 虚拟/隧道网卡的名字特征：它们通常不是对方设备能访问的那张网卡（名字仍会展示，只是排在后面）。
const VIRTUAL_INTERFACE_NAME =
  /virtual|vmware|hyper-v|vethernet|wsl|docker|tailscale|zerotier|clash|meta|tun|tap|bluetooth/i;

/** 从 networkInterfaces() 结果里挑出可用于局域网访问的 IPv4 地址；纯函数，便于测试。 */
export function pickLanAddresses(interfaces) {
  const found = [];
  for (const [name, entries] of Object.entries(interfaces || {})) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (UNUSABLE_LAN_ADDRESS.some((pattern) => pattern.test(entry.address)))
        continue;
      found.push({
        name,
        address: entry.address,
        virtual: VIRTUAL_INTERFACE_NAME.test(name),
      });
    }
  }
  // 实体网卡优先作为主地址；同组内保留系统顺序（sort 是稳定的）。
  found.sort((a, b) => Number(a.virtual) - Number(b.virtual));
  return found.map(({ name, address }) => ({ name, address }));
}

/** 本机可被局域网访问的 IPv4 地址（实体网卡优先，排除内部/不可用地址）。 */
export function lanAddresses() {
  return pickLanAddresses(networkInterfaces());
}

/** One server belongs to one live pi process. No session files are written. */
export async function startServer({ snapshot, action, connection }) {
  const token = connection?.token || randomBytes(32).toString("hex");
  // 局域网模式（/web-wlan）：监听 0.0.0.0，并按约定不校验 Host/Origin ——
  // 此时 URL 里的随机凭证是唯一凭据。
  const lan = connection?.host === "0.0.0.0";
  const clients = new Map();
  const staticAssets = await configuredAssets();
  const importMapCspHash = await importMapHash();
  let origin;
  const server = createServer(async (req, res) => {
    const reply = (status, value) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(value));
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'${importMapCspHash ? ` ${importMapCspHash}` : ""}; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    );
    try {
      if (
        !lan &&
        (req.headers.host !== new URL(origin).host ||
          (req.headers.origin && req.headers.origin !== origin))
      ) {
        return reply(403, { error: "请求来源不匹配" });
      }
      const url = new URL(req.url, origin);
      if (req.method === "GET" && url.pathname === "/favicon.ico") {
        res.writeHead(204, { "Cache-Control": "public, max-age=86400" });
        return res.end();
      }
      const asset = staticAssets.get(url.pathname);
      if (asset && req.method === "GET") {
        const body = await readFile(new URL(asset[0], import.meta.url));
        res.writeHead(200, { "Content-Type": `${asset[1]}; charset=utf-8` });
        return res.end(body);
      }
      if (req.headers.authorization !== `Bearer ${token}`)
        return reply(401, { error: "连接凭证已失效，请在 TUI 执行 /web" });
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          Connection: "keep-alive",
        });
        res.flushHeaders();
        clients.set(res, {
          streamId: randomUUID(),
          sequence: 0,
          sessionId: null,
          ready: false,
        });
        sendSnapshot(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/action") {
        if (!req.headers["content-type"]?.startsWith("application/json"))
          return reply(415, { error: "需要 JSON" });
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 24 * 1024 * 1024) {
            reply(413, { error: "消息过长" });
            return;
          }
          chunks.push(chunk);
        }
        let input;
        try {
          input = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          return reply(400, { error: "无效 JSON" });
        }
        validateAction(input);
        const result = await action(input);
        return reply(200, { ok: true, ...result });
      }
      reply(404, { error: "不存在的接口" });
    } catch (error) {
      if (!res.headersSent) reply(400, { error: error.message });
      else res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(connection?.port || 0, lan ? "0.0.0.0" : "127.0.0.1", resolve);
  });
  const port = server.address().port;
  origin = `http://127.0.0.1:${port}`;
  const addresses = lan ? lanAddresses() : [];
  // 局域网模式下对外展示第一个非内部网卡地址；取不到时回退到回环地址。
  const publicOrigin = addresses.length
    ? `http://${addresses[0].address}:${port}`
    : origin;
  function encode(event) {
    try {
      const wireEvent = JSON.parse(JSON.stringify(event));
      return `data: ${JSON.stringify(validateServerEvent(wireEvent))}\n\n`;
    } catch {
      return null;
    }
  }
  function write(res, frame) {
    try {
      res.write(frame);
      return true;
    } catch {
      clients.delete(res);
      res.destroy();
      return false;
    }
  }
  function sendSnapshot(res) {
    const client = clients.get(res);
    if (!client) return false;
    let state;
    try {
      state = JSON.parse(JSON.stringify(snapshot()));
    } catch {
      return false;
    }
    const streamId =
      client.ready && client.sessionId !== state.sessionId
        ? randomUUID()
        : client.streamId;
    const frame = encode({
      schemaVersion: 1,
      type: "snapshot",
      streamId,
      sequence: 0,
      sessionId: state.sessionId,
      snapshot: state,
    });
    if (!frame || !write(res, frame)) return false;
    client.streamId = streamId;
    client.sessionId = state.sessionId;
    client.sequence = 1;
    client.ready = true;
    return true;
  }
  const heartbeat = setInterval(() => {
    for (const client of clients.keys()) {
      try {
        client.write(": heartbeat\n\n");
      } catch {
        clients.delete(client);
        client.destroy();
      }
    }
  }, 15000);
  heartbeat.unref();
  return {
    url: `${publicOrigin}/#${token}`,
    addresses,
    connection: { port, token, ...(lan ? { host: "0.0.0.0" } : {}) },
    publish(patch = {}, sessionId) {
      if (!clients.size) return;
      const hasPatch = Object.keys(patch).length > 0;
      for (const [client, state] of clients) {
        if (!state.ready || (sessionId && state.sessionId !== sessionId)) {
          sendSnapshot(client);
          continue;
        }
        const frame = hasPatch
          ? encode({
              schemaVersion: 1,
              type: "patch",
              streamId: state.streamId,
              sequence: state.sequence,
              sessionId: state.sessionId,
              patch,
            })
          : null;
        if (frame && write(client, frame)) state.sequence++;
      }
    },
    async close() {
      clearInterval(heartbeat);
      for (const client of clients.keys()) client.end();
      clients.clear();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}
