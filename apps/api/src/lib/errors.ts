/** Error carrying an HTTP status, rendered as RFC 9457 problem+json by the app error handler. */
export class ProblemError extends Error {
  readonly status: number;
  readonly title: string;

  constructor(status: number, title: string, detail?: string) {
    super(detail ?? title);
    this.status = status;
    this.title = title;
  }
}

export const badRequest = (detail: string): ProblemError =>
  new ProblemError(400, "Bad Request", detail);
export const unauthorized = (detail = "Authentication required"): ProblemError =>
  new ProblemError(401, "Unauthorized", detail);
export const forbidden = (detail = "You do not have permission to do that"): ProblemError =>
  new ProblemError(403, "Forbidden", detail);
export const notFound = (detail = "Resource not found"): ProblemError =>
  new ProblemError(404, "Not Found", detail);
export const conflict = (detail: string): ProblemError =>
  new ProblemError(409, "Conflict", detail);
export const unprocessable = (detail: string): ProblemError =>
  new ProblemError(422, "Validation Error", detail);
export const tooManyRequests = (detail: string): ProblemError =>
  new ProblemError(429, "Too Many Requests", detail);
