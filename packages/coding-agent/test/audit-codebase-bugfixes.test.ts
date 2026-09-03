import { describe, expect, it } from "vitest";
import { parseAvoClaimVerifierMessage } from "../src/core/avo/claim-verifier.js";
import {
	assessAvoHostCommand,
	classifyAvoHostEvaluationCommand,
	deriveAvoDeterministicArithmeticContract,
	deriveAvoObservedTestIdentities,
} from "../src/core/avo/evaluator.js";
import { parseAvoTrialMetricsOutput } from "../src/core/avo/experiment.js";
import { isAvoVerifierScript, isTestFile } from "../src/core/avo/workspace.js";

describe("Codebase Bug Audits and Edge Cases", () => {
	describe("Bug 1: deriveAvoDeterministicArithmeticContract with trailing equals or question mark", () => {
		it("derives deterministic contract from expressions with trailing equals", () => {
			const contract = deriveAvoDeterministicArithmeticContract("calculate 10 + 20 =");
			expect(contract.expression).toBe("10 + 20");
			expect(contract.result).toBe("30");
		});

		it("derives deterministic contract from expressions with trailing equals and question mark", () => {
			const contract = deriveAvoDeterministicArithmeticContract("what is (100 - 40) / 2 = ?");
			expect(contract.expression).toBe("(100 - 40) / 2");
			expect(contract.result).toBe("30");
		});

		it("still rejects malformed or unclosed arithmetic expressions", () => {
			expect(() => deriveAvoDeterministicArithmeticContract("calculate 10 +")).toThrow();
			expect(() => deriveAvoDeterministicArithmeticContract("what is (10 + 20")).toThrow();
		});
	});

	describe("Bug 2: Python standard library unittest classification, assessment, and identities", () => {
		it("classifies python -m unittest commands as test evaluator", () => {
			expect(classifyAvoHostEvaluationCommand("python -m unittest")).toBe("test");
			expect(classifyAvoHostEvaluationCommand("python3 -m unittest discover -s test")).toBe("test");
			expect(classifyAvoHostEvaluationCommand("uv run python -m unittest")).toBe("test");
		});

		it("correctly parses passing unittest output in assessAvoHostCommand", () => {
			const output = `......................................................................
----------------------------------------------------------------------
Ran 70 tests in 0.123s

OK
`;
			const assessment = assessAvoHostCommand("test", {
				exitCode: 0,
				cancelled: false,
				truncated: false,
				output,
			});
			expect(assessment.status).toBe("pass");
			expect(assessment.metrics.observed_work_units).toBe(70);
			expect(assessment.metrics.observed_passed_work_units).toBe(70);
			expect(assessment.metrics.result_parser).toBe("python_unittest");
			expect(assessment.metrics.meaningful).toBe(true);
		});

		it("correctly parses failing unittest output in assessAvoHostCommand", () => {
			const output = `======================================================================
FAIL: test_sub (test_math.TestMath.test_sub)
----------------------------------------------------------------------
AssertionError: 5 != 4

----------------------------------------------------------------------
Ran 20 tests in 0.050s

FAILED (failures=1, errors=2, skipped=1)
`;
			const assessment = assessAvoHostCommand("test", {
				exitCode: 1,
				cancelled: false,
				truncated: false,
				output,
			});
			expect(assessment.status).toBe("fail");
			expect(assessment.metrics.observed_work_units).toBe(20);
			expect(assessment.metrics.observed_passed_work_units).toBe(16);
			expect(assessment.metrics.result_parser).toBe("python_unittest");
			expect(assessment.metrics.meaningful).toBe(true);
		});

		it("extracts test identities from verbose unittest output", () => {
			const output = `test_add (test_math.TestMath.test_add) ... ok
test_sub (test_math.TestMath.test_sub) ... FAIL
test_div (test_math.TestMath.test_div) ... ERROR
test_skip (test_math.TestMath.test_skip) ... skipped 'reason'

----------------------------------------------------------------------
Ran 4 tests in 0.010s

FAILED (failures=1, errors=1, skipped=1)
`;
			const identities = deriveAvoObservedTestIdentities(output);
			expect(identities).toContain("unittest:1:test_add (test_math.TestMath.test_add)");
			expect(identities).toContain("unittest:2:test_sub (test_math.TestMath.test_sub)");
			expect(identities).toContain("unittest:3:test_div (test_math.TestMath.test_div)");
			expect(identities).toContain("unittest:4:test_skip (test_math.TestMath.test_skip)");
		});
	});

	describe("Bug 3: Multi-language verifiers and test scripts in isTestFile and isAvoVerifierScript", () => {
		it("recognizes TypeScript, JavaScript, and Shell verifier scripts", () => {
			expect(isTestFile("verify_solution.ts")).toBe(true);
			expect(isTestFile("verify_solution.js")).toBe(true);
			expect(isTestFile("check_solution.ts")).toBe(true);
			expect(isTestFile("test_parser.ts")).toBe(true);
			expect(isTestFile("certify_performance.sh")).toBe(true);
			expect(isTestFile("benchmark_runner.mjs")).toBe(true);

			expect(isAvoVerifierScript("verify_solution.ts")).toBe(true);
			expect(isAvoVerifierScript("verify_solution.js")).toBe(true);
			expect(isAvoVerifierScript("check_solution.ts")).toBe(true);
			expect(isAvoVerifierScript("certify_performance.sh")).toBe(true);
			expect(isAvoVerifierScript("validate_output.cjs")).toBe(true);
		});

		it("does not false-positive on regular source files", () => {
			expect(isTestFile("src/index.ts")).toBe(false);
			expect(isTestFile("app/main.js")).toBe(false);
			expect(isTestFile("lib/parser.py")).toBe(false);

			expect(isAvoVerifierScript("src/index.ts")).toBe(false);
			expect(isAvoVerifierScript("app/main.js")).toBe(false);
			expect(isAvoVerifierScript("lib/parser.py")).toBe(false);
			expect(isAvoVerifierScript("conftest.py")).toBe(false);
		});
	});

	describe("Bug 4: parseAvoClaimVerifierMessage markdown code block tolerance", () => {
		const marker = "AVO_CLAIM_VERDICT_JSON:cand-1:claim-1";

		it("parses raw JSON verdict", () => {
			const message = `${marker}\n{\n  "relation": "supports",\n  "reason": "quote matches",\n  "objective_relation": "addresses",\n  "objective_reason": "answers objective"\n}`;
			const verdict = parseAvoClaimVerifierMessage(message, marker);
			expect(verdict.relation).toBe("supports");
			expect(verdict.objectiveRelation).toBe("addresses");
		});

		it("parses JSON verdict enclosed in markdown code fences", () => {
			const message = `${marker}\n\`\`\`json\n{\n  "relation": "supports",\n  "reason": "quote matches",\n  "objective_relation": "addresses",\n  "objective_reason": "answers objective"\n}\n\`\`\``;
			const verdict = parseAvoClaimVerifierMessage(message, marker);
			expect(verdict.relation).toBe("supports");
			expect(verdict.objectiveRelation).toBe("addresses");
		});
	});

	describe("Bug 5: parseAvoTrialMetricsOutput leading whitespace tolerance", () => {
		it("parses metrics even if line has leading spaces from logger or shell indentation", () => {
			const output = 'Running test...\n  AVO_TRIAL_METRICS_JSON:{"score": 42.5}\nCompleted.';
			const metrics = parseAvoTrialMetricsOutput(output, "score");
			expect(metrics.score).toBe(42.5);
		});
	});
});
