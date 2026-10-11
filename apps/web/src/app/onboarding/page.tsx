"use client";

import type { OnboardingSuggestedView } from "@gg/sdk";
import { GGApiError } from "@gg/sdk";
import { Button } from "@gg/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { CommunityCard } from "../../components/CommunityCard";
import { JoinButton } from "../../components/FollowButton";
import { ApiErrorState, FeedSkeleton } from "../../components/States";
import { UserRow } from "../../components/UserRow";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";

const STEPS = ["Topics", "Communities", "People"] as const;

/**
 * Post-register onboarding: pick topics, join starter communities, follow
 * suggested accounts (the platform agent first). Every step is skippable;
 * finishing (or skipping) records completion server-side so the guard on
 * this page bounces completed users straight to /home.
 */
export default function OnboardingPage() {
  const { status, user, refreshUser } = useSession();
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [suggested, setSuggested] = useState<OnboardingSuggestedView | null>(null);
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "anonymous") router.replace("/login");
    else if (status === "authenticated" && user?.onboardingCompletedAt) {
      router.replace("/home");
    }
  }, [status, user, router]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSuggested(await api.getOnboardingSuggested());
    } catch (cause) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === "authenticated" && !user?.onboardingCompletedAt) void load();
  }, [status, user, load]);

  function toggleTopic(topic: string) {
    setSelectedTopics((current) =>
      current.includes(topic)
        ? current.filter((t) => t !== topic)
        : [...current, topic].slice(0, 12),
    );
  }

  async function finish() {
    setFinishing(true);
    setFinishError(null);
    try {
      await api.completeOnboarding({ topics: selectedTopics });
      await refreshUser().catch(() => undefined);
      router.replace("/home");
    } catch (cause) {
      setFinishError(
        cause instanceof GGApiError ? cause.detail : "Couldn't save your picks. Try again.",
      );
      setFinishing(false);
    }
  }

  if (status !== "authenticated" || user?.onboardingCompletedAt) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col px-4 py-10">
        <FeedSkeleton count={2} />
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col px-4 py-10 text-text">
      <Link
        href="/home"
        aria-label="GG home"
        className="font-display text-3xl font-bold tracking-tight"
      >
        GG<span className="text-accent">.</span>
      </Link>
      <h1 className="mt-8 font-display text-3xl font-bold">Set up your floor</h1>
      <p className="mt-2 text-text-muted">
        Three quick picks so your home feed starts with people and places you care about.
        Skip anything — you can change it all later.
      </p>

      <ol aria-label="Onboarding steps" className="mt-6 flex gap-2">
        {STEPS.map((label, index) => (
          <li
            key={label}
            aria-current={index === step ? "step" : undefined}
            className={`flex-1 rounded-full px-3 py-1.5 text-center text-sm font-medium ${
              index === step
                ? "bg-accent text-accent-ink"
                : index < step
                  ? "bg-accent-tint text-text"
                  : "bg-surface-sunken text-text-muted"
            }`}
          >
            {index + 1}. {label}
          </li>
        ))}
      </ol>

      <div className="mt-8">
        {loading ? (
          <FeedSkeleton count={2} />
        ) : error ? (
          <ApiErrorState error={error} onRetry={() => void load()} />
        ) : suggested ? (
          <>
            {step === 0 ? (
              <section aria-label="Pick your topics" data-testid="onboarding-topics">
                <h2 className="font-display text-xl font-semibold">What are you here for?</h2>
                <p className="mt-1 text-sm text-text-muted">Pick up to 12 topics.</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {suggested.topics.map((topic) => {
                    const selected = selectedTopics.includes(topic);
                    return (
                      <button
                        key={topic}
                        type="button"
                        aria-pressed={selected}
                        data-testid="onboarding-topic-chip"
                        onClick={() => toggleTopic(topic)}
                        className={`min-h-11 rounded-full border px-4 font-medium transition-colors ${
                          selected
                            ? "border-accent bg-accent text-accent-ink"
                            : "border-border bg-surface hover:border-border-strong"
                        }`}
                      >
                        #{topic}
                      </button>
                    );
                  })}
                </div>
              </section>
            ) : null}

            {step === 1 ? (
              <section aria-label="Join communities" data-testid="onboarding-communities">
                <h2 className="font-display text-xl font-semibold">Join a few communities</h2>
                <p className="mt-1 text-sm text-text-muted">
                  The busiest rooms on GG right now.
                </p>
                <ul className="mt-4 flex flex-col gap-3">
                  {suggested.communities.map((community) => (
                    <li
                      key={community.id}
                      className="flex items-center gap-2"
                    >
                      <div className="min-w-0 flex-1">
                        <CommunityCard community={community} />
                      </div>
                      <JoinButton
                        slug={community.slug}
                        initialMember={community.viewerMembership?.status === "active"}
                      />
                    </li>
                  ))}
                </ul>
                {suggested.communities.length === 0 ? (
                  <p className="mt-4 text-sm text-text-muted">
                    No communities to suggest yet — you'll find them in Explore.
                  </p>
                ) : null}
              </section>
            ) : null}

            {step === 2 ? (
              <section aria-label="Follow people" data-testid="onboarding-people">
                <h2 className="font-display text-xl font-semibold">Follow a few accounts</h2>
                <p className="mt-1 text-sm text-text-muted">
                  GG Scout is our labeled house agent — it posts the daily prompts.
                </p>
                <ul className="mt-4 flex flex-col gap-3">
                  {suggested.accounts.map((profile) => (
                    <li key={profile.userId}>
                      <UserRow profile={profile} />
                    </li>
                  ))}
                </ul>
                {suggested.accounts.length === 0 ? (
                  <p className="mt-4 text-sm text-text-muted">
                    Nobody to suggest yet — you're early.
                  </p>
                ) : null}
              </section>
            ) : null}
          </>
        ) : null}
      </div>

      {finishError ? (
        <p role="alert" className="mt-6 rounded-md bg-surface-sunken px-3 py-2 text-sm text-danger">
          {finishError}
        </p>
      ) : null}

      <div className="mt-10 flex items-center justify-between gap-3">
        <Button
          variant="ghost"
          onClick={() => void finish()}
          disabled={finishing}
          data-testid="onboarding-skip"
        >
          Skip onboarding
        </Button>
        <div className="flex gap-2">
          {step > 0 ? (
            <Button
              variant="ghost"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              data-testid="onboarding-back"
            >
              Back
            </Button>
          ) : null}
          {step < STEPS.length - 1 ? (
            <Button onClick={() => setStep((s) => s + 1)} data-testid="onboarding-next">
              Continue
            </Button>
          ) : (
            <Button
              onClick={() => void finish()}
              disabled={finishing}
              data-testid="onboarding-finish"
            >
              {finishing ? "Saving…" : "Finish"}
            </Button>
          )}
        </div>
      </div>
    </main>
  );
}
