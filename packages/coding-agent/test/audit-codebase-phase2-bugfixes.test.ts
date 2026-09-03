import { describe, expect, it } from "vitest";
import { deriveAvoExperimentOutcome, digestAvoExperimentSelectionBinding } from "../src/core/avo/experiment.js";
import { parseAvoMemoryReasonerMessage } from "../src/core/avo/memory-reasoner.js";
import { deriveAvoCandidateImpactSurfaces } from "../src/core/avo/obligations.js";
import { parseAvoSupervisorPayload } from "../src/core/avo/supervisor.js";
import type { AvoCandidate, AvoExperimentPlan, AvoTrial } from "../src/core/avo/types.js";
import { AvoProgressWatchdog, deriveAvoProgressWatchdogSnapshot } from "../src/core/avo/watchdog.js";

describe("Codebase Bug Audits Phase 2", () => {
	describe("Bug 7: deriveAvoExperimentOutcome graceful retention on insufficient paired observations (df < 1)", () => {
		it("does not throw on single paired observation and retains baseline gracefully", () => {
			const plan: AvoExperimentPlan = {
				stage: "confirmation",
				mode: "prospective",
				expectedTrials: 2,
				candidateIds: ["cand-base", "cand-challenger"],
				baselineCandidateId: "cand-base",
				primaryMetric: "throughput",
				metricDirection: "maximize",
				pairing: "paired",
				conditions: [{ conditionId: "c1", label: "c1", parameters: {}, commandTemplate: "echo" }],
				seeds: ["s1"],
				promotion: {
					minimumAbsoluteEffect: 10,
					minimumRelativeEffect: 0.05,
					minimumPairedObservations: 5,
				},
				selectionReservation: {
					policyVersion: "project_fwer_online_bonferroni_v1",
					familyId: "a".repeat(64),
					reservationId: "b".repeat(64),
					bindingDigest: "",
					attemptIndex: 1,
					familywiseAlpha: 0.05,
					allocatedAlpha: 0.025,
					cumulativeAlpha: 0.025,
					reservedAt: new Date().toISOString(),
				},
			};
			plan.selectionReservation!.bindingDigest = digestAvoExperimentSelectionBinding("exp-1", plan);

			const trials: AvoTrial[] = [
				{
					trialId: "t1",
					experimentId: "exp-1",
					candidateId: "cand-base",
					conditionId: "c1",
					seed: "s1",
					evaluationId: "eval-1",
					label: "trial 1",
					evidenceRefs: [],
					status: "pass",
					metrics: { throughput: 100 },
					recordedAt: new Date().toISOString(),
				},
				{
					trialId: "t2",
					experimentId: "exp-1",
					candidateId: "cand-challenger",
					conditionId: "c1",
					seed: "s1",
					evaluationId: "eval-2",
					label: "trial 2",
					evidenceRefs: [],
					status: "pass",
					metrics: { throughput: 150 },
					recordedAt: new Date().toISOString(),
				},
			];

			const outcome = deriveAvoExperimentOutcome({ experimentId: "exp-1", plan } as any, trials);
			expect(outcome.decision).toBe("retain");
			expect(outcome.championCandidateId).toBe("cand-base");
			expect(outcome.reason).toContain("automatic promotion requires at least 5");
		});
	});

	describe("Bug 8: AvoProgressWatchdog recognizes candidate additions as observable progress", () => {
		it("updates snapshot token and reports progress when a new candidate is registered", () => {
			const state1: any = {
				runId: "run-wd-1",
				routing: { environment: "general" },
				evaluations: [],
				candidates: [],
				cycles: [],
				trials: [],
				experiments: [],
				obligations: [],
				obligationCoverage: [],
				criticalAssumptions: [],
			};

			const state2: any = {
				...state1,
				candidates: [
					{
						candidateId: "cand-1",
						payloadDigest: "digest-1",
						workspaceDigest: "ws-1",
					},
				],
			};

			const watchdog = new AvoProgressWatchdog();
			const snap1 = deriveAvoProgressWatchdogSnapshot(state1);
			watchdog.prime(snap1);

			const snap2 = deriveAvoProgressWatchdogSnapshot(state2);
			const assessment = watchdog.observe(snap2);

			expect(snap2.token).not.toBe(snap1.token);
			expect(assessment.madeProgress).toBe(true);
			expect(assessment.action).toBe("progress");
			expect(assessment.progressIndicators).toContain("a new candidate was registered");
		});
	});

	describe("Bug 9: deriveAvoCandidateImpactSurfaces recognizes biome.json and lockfile configurations", () => {
		it("detects biome.json, .prettierrc.json, package-lock.json, and uv.lock as configuration impact surfaces", () => {
			const candidate: Partial<AvoCandidate> = {
				candidateId: "c1",
				workspaceChangedPaths: ["biome.json", ".prettierrc.json", "package-lock.json", "uv.lock", "Cargo.lock"],
			};

			const surfaces = deriveAvoCandidateImpactSurfaces(candidate as AvoCandidate);
			expect(surfaces.length).toBe(1);
			expect(surfaces[0]!.kind).toBe("configuration");
			expect(surfaces[0]!.paths).toContain("biome.json");
			expect(surfaces[0]!.paths).toContain(".prettierrc.json");
			expect(surfaces[0]!.paths).toContain("package-lock.json");
			expect(surfaces[0]!.paths).toContain("uv.lock");
			expect(surfaces[0]!.paths).toContain("Cargo.lock");
			expect(surfaces[0]!.requiredEvidenceGroups).toEqual([["test"], ["build", "runtime"]]);
		});
	});

	describe("Bug 10: parseAvoSupervisorPayload markdown code block tolerance", () => {
		it("parses supervisor payload wrapped in markdown fences", () => {
			const message = `AVO_SUPERVISION_JSON:cycle-42
\`\`\`json
{
  "cycle_id": "cycle-42",
  "review": "approved",
  "rationale": "all tests verified"
}
\`\`\``;
			const payload = parseAvoSupervisorPayload(message, "cycle-42");
			expect(payload.cycle_id).toBe("cycle-42");
			expect(payload.review).toBe("approved");
		});
	});

	describe("Bug 11: parseAvoMemoryReasonerMessage markdown code block tolerance", () => {
		it("parses reflections wrapped in markdown fences", () => {
			const marker = "UNIQUE_REASONER_MARKER";
			const message = `${marker}
\`\`\`json
{
  "reflections": [
    {
      "title": "Cache Locality",
      "content": "Tiling improves shared memory bandwidth",
      "tags": ["cuda", "performance"],
      "source_episode_ids": ["ep-1", "ep-2"]
    }
  ]
}
\`\`\``;
			const proposals = parseAvoMemoryReasonerMessage(message, marker, new Set(["ep-1", "ep-2"]));
			expect(proposals.length).toBe(1);
			expect(proposals[0]!.title).toBe("Cache Locality");
			expect(proposals[0]!.sourceEpisodeIds).toEqual(["ep-1", "ep-2"]);
		});
	});
});
