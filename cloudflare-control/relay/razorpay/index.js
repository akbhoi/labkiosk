/**
 * Cloud Run functions entry point for the Razorpay relay (see handler.js).
 * Deploy steps: docs/DEPLOYMENT.md, "Razorpay relay on Google Cloud".
 */

import functions from "@google-cloud/functions-framework";
import { handleRelay } from "./handler.js";

functions.http("relay", async (req, res) => {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  try {
    const result = await handleRelay({
      method: req.method,
      // Through https://<region>-<project>.cloudfunctions.net/<name>/v1/... the
      // name may still lead the path; what is signed and forwarded starts at
      // /v1/ and keeps its query (a subscription's invoices).
      path: req.originalUrl.includes("/v1/") ? req.originalUrl.slice(req.originalUrl.indexOf("/v1/")) : req.originalUrl,
      headers,
      body: req.rawBody ? req.rawBody.toString("utf8") : "",
      secret: process.env.RELAY_SECRET,
      nowSeconds: Math.floor(Date.now() / 1000),
      fetchImpl: fetch
    });
    res.status(result.status).set(result.headers).send(result.body);
  } catch (err) {
    console.error("[relay] Unexpected failure:", err);
    res.status(500).json({ error: { description: "The relay failed" } });
  }
});
