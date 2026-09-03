import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyAvoHostEvaluationCommand, deriveAvoObservedTestIdentities } from "../src/core/avo/evaluator.js";
import type { AvoVerificationBaseline } from "../src/core/avo/types.js";
import { captureAvoVerificationHarnessManifest } from "../src/core/avo/workspace.js";

describe("Codebase Bug Audits Phase 3", () => {
	describe("Bug 12: captureAvoVerificationHarnessManifest does not scan package.json as pytest config", () => {
		it("does not report invalid pytest plugin or unsafe capture on package.json files", () => {
			const tempDir = mkdtempSync(join(tmpdir(), "avo-pytest-test-"));
			writeFileSync(
				join(tempDir, "package.json"),
				JSON.stringify({ name: "my-app", scripts: { test: "jest -s -p" } }),
			);
			writeFileSync(join(tempDir, "test_main.py"), "def test_foo(): assert True\n");
			const baseline: AvoVerificationBaseline = {
				kind: "coding",
				contractDigest: "digest-1",
				userAcceptanceCommands: [],
				executions: [],
				capturedAt: new Date().toISOString(),
				workspaceDigest: "ws-1",
				testFiles: [{ path: "test_main.py", sha256: "abc" }],
			};

			const manifest = captureAvoVerificationHarnessManifest(tempDir, "python3 -m pytest -v test_main.py", baseline);
			const pytestConfigErrors = manifest.unsupportedReasons.filter((r) => r.includes("package.json"));
			expect(pytestConfigErrors).toEqual([]);
		});
	});

	describe("Bug 13: deriveAvoObservedTestIdentities extracts vitest test names", () => {
		it("extracts test identities from vitest output lines", () => {
			const output = `
 ✓ test/math.test.ts > suite > should add two numbers 12ms
 ✓ test/math.test.ts > suite > should subtract two numbers (5 ms)
 × test/math.test.ts > suite > should multiply two numbers (10 ms)

 Test Files  1 failed | 0 passed (1)
      Tests  1 failed | 2 passed (3)
`;
			const identities = deriveAvoObservedTestIdentities(output);
			expect(identities).toContain("vitest:1:test/math.test.ts > suite > should add two numbers");
			expect(identities).toContain("vitest:2:test/math.test.ts > suite > should subtract two numbers");
			expect(identities).toContain("vitest:3:test/math.test.ts > suite > should multiply two numbers");
		});
	});

	describe("Bug 14: classifyAvoHostEvaluationCommand recognizes vitest, uv run ruff, cargo clippy, and mypy", () => {
		it("classifies direct vitest run as test", () => {
			expect(classifyAvoHostEvaluationCommand("vitest run")).toBe("test");
			expect(classifyAvoHostEvaluationCommand("jest --colors")).toBe("test");
		});

		it("classifies uv run ruff, cargo clippy, and mypy as lint or build", () => {
			expect(classifyAvoHostEvaluationCommand("uv run ruff check .")).toBe("lint");
			expect(classifyAvoHostEvaluationCommand("cargo clippy --all-targets")).toBe("lint");
			expect(classifyAvoHostEvaluationCommand("mypy .")).toBe("build");
		});
	});

	describe("Bug 15: captureAvoVerificationHarnessManifest accepts direct pytest and vitest commands", () => {
		it("does not reject direct pytest or vitest commands with not a closed runner invocation", () => {
			const tempDir = mkdtempSync(join(tmpdir(), "avo-runner-test-"));
			writeFileSync(join(tempDir, "test_main.py"), "def test_ok(): pass\n");
			const baseline: AvoVerificationBaseline = {
				kind: "coding",
				contractDigest: "digest-2",
				userAcceptanceCommands: [],
				executions: [],
				capturedAt: new Date().toISOString(),
				workspaceDigest: "ws-2",
				testFiles: [{ path: "test_main.py", sha256: "xyz" }],
			};

			const manifest = captureAvoVerificationHarnessManifest(tempDir, "pytest -v test_main.py", baseline);
			expect(manifest.unsupportedReasons).not.toContain(
				"test runner command is not a directly resolved closed runner invocation",
			);
		});
	});
});
