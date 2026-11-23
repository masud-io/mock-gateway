import { handleMockRequest } from "@/server/handler";

// No `runtime` / `dynamic` exports: this project has `cacheComponents` on, which forbids them.
// It runs on Node (required by Cache Components) and Route Handlers are uncached unless they opt in
// with `use cache`, so every mock call is computed per request.

export const GET = handleMockRequest;
export const POST = handleMockRequest;
export const PUT = handleMockRequest;
export const PATCH = handleMockRequest;
export const DELETE = handleMockRequest;
export const HEAD = handleMockRequest;
export const OPTIONS = handleMockRequest;
