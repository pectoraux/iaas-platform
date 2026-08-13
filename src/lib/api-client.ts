// =============================================================================
// Dashboard API client — thin fetch wrapper with tenant scoping + errors.
// =============================================================================

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

export interface ApiFetchOptions {
  method?: "GET" | "POST"
  body?: unknown
  tenantId?: string
  signal?: AbortSignal
}

/**
 * Fetch JSON from a platform API path. Adds `X-Tenant-Id` (when provided) and
 * `Content-Type: application/json`. Throws `ApiError` on non-2xx responses.
 */
export async function apiFetch<T>(
  path: string,
  opts: ApiFetchOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  }
  if (opts.tenantId) headers["x-tenant-id"] = opts.tenantId

  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
    cache: "no-store",
  })

  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }

  if (!res.ok) {
    const dataObj = data && typeof data === "object" ? (data as Record<string, unknown>) : null
    const msg =
      (dataObj &&
        typeof dataObj.error === "object" &&
        dataObj.error !== null &&
        (dataObj.error as { message?: string }).message) ||
      (dataObj && typeof dataObj.message === "string" && dataObj.message) ||
      (typeof data === "string" && data) ||
      res.statusText ||
      `Request failed (${res.status})`
    throw new ApiError(res.status, msg, data)
  }

  return data as T
}
