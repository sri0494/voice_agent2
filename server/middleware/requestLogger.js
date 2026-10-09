import { randomUUID } from "crypto";
import { logger } from "../utils/logger.js";

export function requestLogger(req, res, next) {
  const start = Date.now();
  req.requestId = randomUUID();
  res.setHeader("X-Request-Id", req.requestId);

  res.on("finish", () => {
    logger.info("request", {
      requestId: req.requestId,
      method: req.method,
      endpoint: req.originalUrl.split("?")[0],   // query strings can carry tokens: never logged
      status: res.statusCode,
      durationMs: Date.now() - start,
    });
  });
  next();
}
