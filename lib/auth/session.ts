import { cache } from "react";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "./options";

// Next 16 deprecates middleware/proxy for this and recommends checking at each
// entry point instead — a layout doesn't stop a Server Action or API route from
// being reachable directly. Call one of these two everywhere auth is needed,
// not a single shared gate.

/** For Server Components / pages: redirects to /login if there's no session. */
export const requireUser = cache(async () => {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
});

/** For API routes / Server Actions: returns null instead of redirecting — a fetch() caller can't follow a redirect meaningfully. */
export const getSessionUser = cache(async () => {
  const session = await getServerSession(authOptions);
  return session?.user ?? null;
});
