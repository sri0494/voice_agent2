import { logger } from "../utils/logger.js";

export class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function notFoundHandler(req, res) {
  res.status(404).json({ success: false, message: "Route not found" });
}

// Database errors become safe, consistent HTTP errors. SQL text, constraint names and stack traces are never sent to the client.
function mapKnownError(err) {
  if (err.type === "entity.too.large") return { status: 413, message: "Request body too large" };
  if (err.type === "entity.parse.failed" || err.type === "encoding.unsupported" || err.type === "charset.unsupported") return { status: 400, message: "Malformed request body" };
  if (err.statusCode) return { status: err.statusCode, message: err.message };
  switch (err.code) {
    case "22P02": case "22007": case "22008": return { status: 400, message: "Invalid identifier or value" };
    case "23505": return { status: 409, message: "That value already exists" };
    case "23503": return { status: 409, message: "This item is linked to other records" };
    case "23502": case "23514": case "22001": case "22003": return { status: 422, message: "Invalid value" };
  }
  if (err.type === "entity.too.large") return { status: 413, message: "Request body too large" };
  if (err.type === "entity.parse.failed") return { status: 400, message: "Malformed JSON" };
  return null;
}

// Express error handler: must have 4 args to be recognised.
export function errorHandler(err, req, res, _next) {
  const known = mapKnownError(err);
  const status = known?.status || 500;
  logger.error(status >= 500 ? "unhandled_error" : "request_error", {
    requestId: req.requestId, endpoint: req.originalUrl.split("?")[0], message: err.message, code: err.code, statusCode: status,
  });
  res.status(status).json({ success: false, message: status === 500 ? "Something went wrong" : known.message });
}
