"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { FeedSkeleton } from "../../../components/States";
import { useSession } from "../../../lib/session";

/** /profile resolves to the signed-in user's public profile (or /login). */
export default function OwnProfilePage() {
  const { status, user } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "authenticated" && user) {
      router.replace(`/u/${user.handle}`);
    } else if (status === "anonymous") {
      router.replace("/login");
    }
  }, [status, user, router]);

  return <FeedSkeleton count={2} />;
}
