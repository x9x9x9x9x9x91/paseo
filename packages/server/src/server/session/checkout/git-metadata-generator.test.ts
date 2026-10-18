import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  StructuredAgentFallbackError,
  StructuredAgentResponseError,
} from "../../agent/agent-response-loop.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { CheckoutDiffCompare, CheckoutDiffResult } from "../../../utils/checkout-git.js";
import type { WorkspaceGitService } from "../../workspace-git-service.js";
import {
  createAgentStructuredTextGeneration,
  createGitMetadataGenerator,
  type StructuredTextGeneration,
  type StructuredTextGenerationRequest,
} from "./git-metadata-generator.js";

type DiffSource = Pick<WorkspaceGitService, "getCheckoutDiff" | "resolveRepoRoot">;

function createDiffSource(result: CheckoutDiffResult) {
  const diffCalls: Array<{ cwd: string; options: CheckoutDiffCompare }> = [];
  const diffSource: DiffSource = {
    getCheckoutDiff: async (cwd, options) => {
      diffCalls.push({ cwd, options });
      return result;
    },
    // buildMetadataPrompt reads paseo.json overrides from here; an unknown root
    // means no override applies, so the default style is used.
    resolveRepoRoot: async () => "/tmp/git-metadata-generator-test-missing-root",
  };
  return { diffSource, diffCalls };
}

function createGeneration(handler: (request: StructuredTextGenerationRequest<unknown>) => unknown) {
  const generateCalls: Array<StructuredTextGenerationRequest<unknown>> = [];
  const generation: StructuredTextGeneration = {
    generate: async <T>(request: StructuredTextGenerationRequest<T>): Promise<T> => {
      generateCalls.push(request as StructuredTextGenerationRequest<unknown>);
      return handler(request as StructuredTextGenerationRequest<unknown>) as T;
    },
  };
  return { generation, generateCalls };
}

const DIFF_WITH_ONE_FILE: CheckoutDiffResult = {
  diff: "diff --git a/src/foo.ts b/src/foo.ts\n+added\n",
  structured: [
    {
      path: "src/foo.ts",
      isNew: false,
      isDeleted: false,
      additions: 3,
      deletions: 1,
      hunks: [],
      status: "ok",
    },
  ],
};

describe("createGitMetadataGenerator", () => {
  it("generateCommitMessage returns the generated message from an uncommitted-diff prompt", async () => {
    const { diffSource, diffCalls } = createDiffSource(DIFF_WITH_ONE_FILE);
    const { generation, generateCalls } = createGeneration(() => ({
      message: "Fix the flaky retry test",
    }));
    const generator = createGitMetadataGenerator({ workspaceGitService: diffSource, generation });

    const message = await generator.generateCommitMessage("/repo");

    expect(message).toBe("Fix the flaky retry test");
    expect(diffCalls).toEqual([
      { cwd: "/repo", options: { mode: "uncommitted", includeStructured: true } },
    ]);
    expect(generateCalls[0]).toMatchObject({
      cwd: "/repo",
      schemaName: "CommitMessage",
      agentTitle: "Commit generator",
    });
    expect(generateCalls[0].prompt).toContain("Write a concise git commit message");
    expect(generateCalls[0].prompt).toContain("M\tsrc/foo.ts\t(+3 -1)");
    expect(generateCalls[0].prompt).toContain("diff --git a/src/foo.ts");
  });

  it("generateCommitMessage falls back to a default message when generation exhausts its providers", async () => {
    const { diffSource } = createDiffSource(DIFF_WITH_ONE_FILE);
    const { generation } = createGeneration(() => {
      throw new StructuredAgentFallbackError([]);
    });
    const generator = createGitMetadataGenerator({ workspaceGitService: diffSource, generation });

    await expect(generator.generateCommitMessage("/repo")).resolves.toBe("Update files");
  });

  it("generateCommitMessage falls back when the generated response cannot be validated", async () => {
    const { diffSource } = createDiffSource(DIFF_WITH_ONE_FILE);
    const { generation } = createGeneration(() => {
      throw new StructuredAgentResponseError("invalid", {
        lastResponse: "{}",
        validationErrors: ["message: required"],
      });
    });
    const generator = createGitMetadataGenerator({ workspaceGitService: diffSource, generation });

    await expect(generator.generateCommitMessage("/repo")).resolves.toBe("Update files");
  });

  it("generateCommitMessage rethrows errors that are not structured-generation failures", async () => {
    const { diffSource } = createDiffSource(DIFF_WITH_ONE_FILE);
    const { generation } = createGeneration(() => {
      throw new Error("network down");
    });
    const generator = createGitMetadataGenerator({ workspaceGitService: diffSource, generation });

    await expect(generator.generateCommitMessage("/repo")).rejects.toThrow("network down");
  });

  it("generatePullRequestText returns the generated title and body from a base-diff prompt", async () => {
    const { diffSource, diffCalls } = createDiffSource(DIFF_WITH_ONE_FILE);
    const { generation, generateCalls } = createGeneration(() => ({
      title: "Add retry with backoff",
      body: "Retries transient failures up to twice.",
    }));
    const generator = createGitMetadataGenerator({ workspaceGitService: diffSource, generation });

    const result = await generator.generatePullRequestText("/repo", "main");

    expect(result).toEqual({
      title: "Add retry with backoff",
      body: "Retries transient failures up to twice.",
    });
    expect(diffCalls).toEqual([
      { cwd: "/repo", options: { mode: "base", baseRef: "main", includeStructured: true } },
    ]);
    expect(generateCalls[0]).toMatchObject({
      cwd: "/repo",
      schemaName: "PullRequest",
      agentTitle: "PR generator",
    });
    expect(generateCalls[0].prompt).toContain("Write a pull request title and body");
  });

  it("generatePullRequestText falls back to default PR text when generation fails", async () => {
    const { diffSource } = createDiffSource(DIFF_WITH_ONE_FILE);
    const { generation } = createGeneration(() => {
      throw new StructuredAgentFallbackError([]);
    });
    const generator = createGitMetadataGenerator({ workspaceGitService: diffSource, generation });

    await expect(generator.generatePullRequestText("/repo")).resolves.toEqual({
      title: "Update changes",
      body: "Automated PR generated by Paseo.",
    });
  });
});

describe("createAgentStructuredTextGeneration", () => {
  // Every provider reads as unavailable, so the attempts record exactly which ones were tried.
  async function attemptedProviders(input: {
    focusedProvider?: string;
    checkoutAgentProviders: string[];
  }): Promise<string[]> {
    const generation = createAgentStructuredTextGeneration({
      agentManager: {
        getProviderAvailability: async (provider: string) => ({
          provider,
          available: false,
          error: null,
        }),
      } as unknown as AgentManager,
      providerSnapshotManager: {
        listProviders: async () => [
          {
            provider: "claude",
            status: "ready" as const,
            enabled: true,
            source: "builtin" as const,
            models: [{ provider: "claude", id: "claude-haiku-4-5", label: "Haiku" }],
          },
          {
            provider: "claude-zdr",
            status: "ready" as const,
            enabled: true,
            source: "custom" as const,
            models: [{ provider: "claude-zdr", id: "claude-haiku-5-5", label: "Haiku" }],
          },
        ],
      },
      readDaemonConfig: () => ({}),
      getFocusedSelection: () =>
        input.focusedProvider ? { provider: input.focusedProvider } : undefined,
      getCheckoutAgentProviders: () => input.checkoutAgentProviders,
    });
    const error = await generation
      .generate({
        cwd: "/repo",
        prompt: "Write a commit message",
        schema: z.object({ message: z.string() }),
        schemaName: "CommitMessage",
        agentTitle: "Commit generator",
      })
      .catch((caught: unknown) => caught);
    if (!(error instanceof StructuredAgentFallbackError)) {
      throw new Error("expected every provider to be tried and refused");
    }
    return error.attempts.map((attempt) => attempt.provider);
  }

  it("keeps a checkout with an agent on a custom provider on that provider", async () => {
    await expect(
      attemptedProviders({ checkoutAgentProviders: ["claude", "claude-zdr"] }),
    ).resolves.toEqual(["claude-zdr"]);
  });

  it("follows a focused agent on a custom provider", async () => {
    await expect(
      attemptedProviders({ focusedProvider: "claude-zdr", checkoutAgentProviders: [] }),
    ).resolves.toEqual(["claude-zdr"]);
  });

  it("keeps the usual providers when the checkout's agents are on built-in ones", async () => {
    await expect(attemptedProviders({ checkoutAgentProviders: ["claude"] })).resolves.toEqual([
      "claude",
    ]);
  });
});
