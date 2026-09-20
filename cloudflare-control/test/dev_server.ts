import http from "node:http";
import worker from "../src/index";
import { Env } from "../src/types";

const env: Env = {
  DEFAULT_DOMAIN: "labkiosk.akbhoi.com",
  SUPER_ADMIN_EMAIL: "admin@akbhoi.com",
  SUPER_ADMIN_PASSWORD: "SuperAdminPassword2026!",
  ALLOW_LOCAL_DB: "1"
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost:8787"}`);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v) {
        if (Array.isArray(v)) v.forEach((val) => headers.append(k, val));
        else headers.set(k, v);
      }
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    const webReq = new Request(url.toString(), {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method || "") ? undefined : body
    });

    const webRes = await worker.fetch(webReq, env);

    res.statusCode = webRes.status;
    webRes.headers.forEach((val, key) => {
      res.setHeader(key, val);
    });

    const ab = await webRes.arrayBuffer();
    res.end(Buffer.from(ab));
  } catch (err: any) {
    res.statusCode = 500;
    res.end(err.stack || err.message);
  }
});

server.listen(8787, () => {
  console.log("Local Dev Server running at http://127.0.0.1:8787");
});
