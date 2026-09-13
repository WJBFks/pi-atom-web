import { createAskUserAdapter as createAdapter } from "./adapter.ts";
import { buildAskUserResult } from "./result.ts";

export { buildAskUserResult };

export function createAskUserAdapter() {
  return createAdapter(buildAskUserResult);
}

export default function createCompatibility() {
  return createAskUserAdapter();
}

