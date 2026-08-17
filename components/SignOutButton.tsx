"use client";

import { signOut } from "next-auth/react";

export function SignOutButton() {
  return (
    <button
      onClick={() => signOut({ callbackUrl: "/" })}
      className="text-sm text-black/60 hover:text-black dark:text-white/60 dark:hover:text-white"
    >
      Sign out
    </button>
  );
}
