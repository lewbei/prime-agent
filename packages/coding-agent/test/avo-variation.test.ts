import { describe, expect, it } from "vitest";
import type {
	AvoCommittedSolution,
	AvoScoreDimension,
	AvoScoringReceipt,
	AvoScoringUtility,
	AvoVariationContract,
	AvoWorkingAttempt,
} from "../src/core/avo/types.js";
import {
	AvoVariationEpisodeController,
	createAvoLineage,
	detectAvoStagnation,
	executeAvoVariationEpisode,
	isScoreImproving,
	updateAvoLineage,
} from "../src/core/avo/variation.js";

function makeScorer(
	evalFn?: (input: { candidateRef: string; content?: string }) => Promise<Partial<AvoScoringReceipt>>,
	dimensions: AvoScoreDimension[] = [{ name: "accuracy", direction: "maximize" }],
): AvoScoringUtility {
	return {
		scorerId: "test-scorer",
		version: "1.0",
		scorerDigest: "digest-123",
		scoreDimensions: dimensions,
		evaluate: async (input) => {
			const partial = evalFn ? await evalFn(input) : {};
			return {
				scorerId: "test-scorer",
				scorerVersion: "1.0",
				scorerDigest: "digest-123",
				candidateDigest: `cand-digest-${input.candidateRef}`,
				passedCorrectness: partial.passedCorrectness ?? true,
				scores: partial.scores ?? { accuracy: 0.9 },
				executionStatus: partial.executionStatus ?? "pass",
				timestamp: new Date().toISOString(),
				...partial,
			};
		},
	};
}

function makeContract(options?: {
	scorer?: AvoScoringUtility;
	baselineScore?: Record<string, number>;
	dimensions?: AvoScoreDimension[];
}): AvoVariationContract {
	const dims = options?.dimensions ?? [{ name: "accuracy", direction: "maximize" }];
	const scorer = options?.scorer ?? makeScorer(undefined, dims);
	const seedSolution: AvoCommittedSolution = {
		solutionId: "seed-1",
		solutionRef: "solution.py",
		scores: options?.baselineScore ?? { accuracy: 0.8 },
		passedCorrectness: true,
		timestamp: new Date().toISOString(),
	};
	return {
		taskContext: "Optimize test problem",
		lineage: createAvoLineage("lineage-1", seedSolution),
		knowledge: [
			{
				knowledgeId: "k-1",
				title: "Domain Knowledge",
				content: "Use gradient descent",
				kind: "note",
				digest: "k-digest-1",
			},
		],
		scorer,
	};
}

describe("AVO Variation Operator (variation.ts)", () => {
	it("evaluateCandidate binds latestCandidateRef and content digest so finish() commits valid solution without recordEdit", async () => {
		const contract = makeContract();
		const controller = new AvoVariationEpisodeController(contract);

		// Evaluate directly without prior recordEdit
		await controller.evaluateCandidate("candidate.py", "print('hello world')");

		const result = controller.finish();
		expect(result.status).toBe("committed");
		expect(result.candidateSolution).toBeDefined();
		expect(result.candidateSolution?.solutionRef).toBe("candidate.py");
		expect(result.candidateSolution?.passedCorrectness).toBe(true);
		expect(result.candidateSolution?.scores).toEqual({ accuracy: 0.9 });
	});

	it("evaluateCandidate updates latestCandidateRef when switching candidates so finish() does not attribute scores to wrong candidate", async () => {
		const contract = makeContract();
		const controller = new AvoVariationEpisodeController(contract);

		// Edit candidate A
		controller.recordEdit("candidate_A.py", "def a(): pass");

		// Evaluate candidate B
		await controller.evaluateCandidate("candidate_B.py", "def b(): pass");

		const result = controller.finish();
		expect(result.status).toBe("committed");
		expect(result.candidateSolution?.solutionRef).toBe("candidate_B.py");
	});

	it("isScoreImproving returns false when candidate is missing a required score dimension", () => {
		const dimensions: AvoScoreDimension[] = [
			{ name: "accuracy", direction: "maximize" },
			{ name: "latency", direction: "minimize" },
		];

		const baseline = { accuracy: 0.8, latency: 100 };

		// Candidate improved accuracy (+0.1) but omitted latency entirely
		const candidateMissingLatency = { accuracy: 0.9 };
		expect(isScoreImproving(candidateMissingLatency, baseline, dimensions)).toBe(false);

		// Candidate with all dimensions improves
		const candidateComplete = { accuracy: 0.9, latency: 90 };
		expect(isScoreImproving(candidateComplete, baseline, dimensions)).toBe(true);

		// Candidate regressed on latency
		const candidateRegressed = { accuracy: 0.9, latency: 120 };
		expect(isScoreImproving(candidateRegressed, baseline, dimensions)).toBe(false);
	});

	it("updateAvoLineage requires all declared scoreDimensions to match for a tie instead of vacuous empty match", () => {
		const dimensions: AvoScoreDimension[] = [
			{ name: "accuracy", direction: "maximize" },
			{ name: "latency", direction: "minimize" },
		];

		const seed: AvoCommittedSolution = {
			solutionId: "seed-1",
			solutionRef: "seed.py",
			scores: { accuracy: 0.8, latency: 100 },
			passedCorrectness: true,
			timestamp: new Date().toISOString(),
		};
		const lineage = createAvoLineage("lineage-1", seed);

		// Candidate missing latency
		const incompleteCandidate: AvoCommittedSolution = {
			solutionId: "cand-1",
			solutionRef: "cand.py",
			scores: { accuracy: 0.8 },
			passedCorrectness: true,
			timestamp: new Date().toISOString(),
		};

		const resultIncomplete = updateAvoLineage(lineage, incompleteCandidate, dimensions);
		expect(resultIncomplete.updated).toBe(false);

		// Candidate with exact match across all dimensions is a valid tie
		const tieCandidate: AvoCommittedSolution = {
			solutionId: "cand-2",
			solutionRef: "cand.py",
			scores: { accuracy: 0.8, latency: 100 },
			passedCorrectness: true,
			timestamp: new Date().toISOString(),
		};

		const resultTie = updateAvoLineage(lineage, tieCandidate, dimensions);
		expect(resultTie.updated).toBe(true);
	});

	it("detectAvoStagnation strictly resets streak when failures and regressions are interleaved", () => {
		// History from oldest to newest:
		// Attempt 1: Failure
		// Attempt 2: Passing, but regressed score
		// Attempt 3: Failure
		const trajectory: AvoWorkingAttempt[] = [
			{
				attemptId: "1",
				actionType: "evaluate",
				timestamp: new Date().toISOString(),
				receipt: {
					scorerId: "s",
					scorerVersion: "1",
					scorerDigest: "d",
					candidateDigest: "c1",
					passedCorrectness: false,
					executionStatus: "fail",
					scores: { accuracy: 0.5 },
					timestamp: new Date().toISOString(),
				},
			},
			{
				attemptId: "2",
				actionType: "evaluate",
				timestamp: new Date().toISOString(),
				receipt: {
					scorerId: "s",
					scorerVersion: "1",
					scorerDigest: "d",
					candidateDigest: "c2",
					passedCorrectness: true,
					executionStatus: "pass",
					scores: { accuracy: 0.7 }, // Below baseline 0.8 -> regression
					timestamp: new Date().toISOString(),
				},
			},
			{
				attemptId: "3",
				actionType: "evaluate",
				timestamp: new Date().toISOString(),
				receipt: {
					scorerId: "s",
					scorerVersion: "1",
					scorerDigest: "d",
					candidateDigest: "c3",
					passedCorrectness: false,
					executionStatus: "fail",
					scores: { accuracy: 0.5 },
					timestamp: new Date().toISOString(),
				},
			},
		];

		const dimensions: AvoScoreDimension[] = [{ name: "accuracy", direction: "maximize" }];
		const stagnation = detectAvoStagnation(trajectory, 2, { accuracy: 0.8 }, dimensions);

		// Only the latest attempt (attempt 3) is consecutive failure. Attempt 2 broke the streak!
		expect(stagnation.consecutiveFailures).toBe(1);
		expect(stagnation.consecutiveRegressions).toBe(0);
		expect(stagnation.isStagnating).toBe(false);
	});

	it("candidateSolution generates unique solutionId based on content/candidateDigest rather than colliding on candidateRef", async () => {
		const contract = makeContract();
		const controller = new AvoVariationEpisodeController(contract);

		await controller.evaluateCandidate("solution.py", "mutation 1 code");
		const result1 = controller.finish();

		const controller2 = new AvoVariationEpisodeController(contract);
		await controller2.evaluateCandidate("solution.py", "mutation 2 code");
		const result2 = controller2.finish();

		expect(result1.candidateSolution?.solutionId).toBeDefined();
		expect(result2.candidateSolution?.solutionId).toBeDefined();
		// Different mutated content must produce distinct solution IDs even for identical candidateRef
		expect(result1.candidateSolution?.solutionId).not.toBe(result2.candidateSolution?.solutionId);
	});

	it("executeAvoVariationEpisode runs agent session and tracks lineage and knowledge sampling faithfully to AVO paper", async () => {
		const contract = makeContract();

		const result = await executeAvoVariationEpisode(contract, async (agent) => {
			const lineage = agent.listLineage();
			expect(lineage.length).toBe(1);
			const parent = agent.sampleLineage(lineage[0].solutionId, "inspect baseline");
			expect(parent.solutionId).toBe("seed-1");

			const knowledge = agent.listKnowledge();
			expect(knowledge.length).toBe(1);
			const k = agent.sampleKnowledge(knowledge[0].knowledgeId, "consult algorithm");
			expect(k.knowledgeId).toBe("k-1");

			agent.recordEdit("candidate.py", "refined code", undefined, "applied knowledge");
			await agent.evaluateCandidate("candidate.py", "refined code");
		});

		expect(result.status).toBe("committed");
		expect(result.sampledLineageIds).toContain("seed-1");
		expect(result.sampledKnowledgeIds).toContain("k-1");
		expect(result.evaluationCount).toBe(1);
		expect(result.trajectory.length).toBe(4); // sample lineage, sample knowledge, edit, evaluate
	});
});
