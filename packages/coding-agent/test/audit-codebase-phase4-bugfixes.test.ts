import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assessAvoTestTrust,
	captureAvoCodingVerificationBaseline,
	captureAvoVerificationHarnessManifest,
} from "../src/core/avo/workspace.js";

describe("AVO Workspace Harness & Runner Trust Phase 4 Audit", () => {
	it("does not falsely classify python3 -m unittest -v as narrowed_selection due to -m flag", () => {
		const tempDir = join(tmpdir(), `avo-unittest-trust-${Date.now()}`);
		mkdirSync(join(tempDir, "test"), { recursive: true });
		writeFileSync(
			join(tempDir, "test", "test_sample.py"),
			"import unittest\nclass TestSample(unittest.TestCase):\n    def test_pass(self): pass\n",
		);

		try {
			const baseline = captureAvoCodingVerificationBaseline(tempDir, "Run tests with python3 -m unittest");
			const assessment = assessAvoTestTrust(tempDir, "python3 -m unittest -v test/test_sample.py", baseline);

			expect(assessment.narrowedSelection).toBe(false);
			expect(assessment.basis).not.toBe("narrowed_selection");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("recognizes npx vitest and npx --yes jest as closed node_test runners in harness manifest", () => {
		const tempDir = join(tmpdir(), `avo-npx-vitest-trust-${Date.now()}`);
		mkdirSync(join(tempDir, "test"), { recursive: true });
		writeFileSync(
			join(tempDir, "test", "sample.test.ts"),
			"import { test, expect } from 'vitest'; test('ok', () => expect(1).toBe(1));",
		);

		try {
			const baseline = captureAvoCodingVerificationBaseline(tempDir, "Run tests with vitest");
			const manifestVitest = captureAvoVerificationHarnessManifest(
				tempDir,
				"npx vitest run test/sample.test.ts",
				baseline,
			);

			expect(manifestVitest.runnerFamily).toBe("node_test");
			expect(
				manifestVitest.unsupportedReasons.some((reason) =>
					reason.includes("not a directly resolved closed runner invocation"),
				),
			).toBe(false);

			const manifestJest = captureAvoVerificationHarnessManifest(
				tempDir,
				"npx --yes jest test/sample.test.ts",
				baseline,
			);
			expect(manifestJest.runnerFamily).toBe("node_test");
			expect(
				manifestJest.unsupportedReasons.some((reason) =>
					reason.includes("not a directly resolved closed runner invocation"),
				),
			).toBe(false);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("recognizes uv run pytest and uv run python3 -m unittest as closed python runners in harness manifest", () => {
		const tempDir = join(tmpdir(), `avo-uv-run-trust-${Date.now()}`);
		mkdirSync(join(tempDir, "test"), { recursive: true });
		writeFileSync(join(tempDir, "test", "test_sample.py"), "def test_sample(): pass\n");

		try {
			const baseline = captureAvoCodingVerificationBaseline(tempDir, "Run tests with uv");
			const manifestUvPytest = captureAvoVerificationHarnessManifest(
				tempDir,
				"uv run pytest -v test/test_sample.py",
				baseline,
			);

			expect(manifestUvPytest.runnerFamily).toBe("pytest");
			expect(
				manifestUvPytest.unsupportedReasons.some((reason) =>
					reason.includes("not a directly resolved closed runner invocation"),
				),
			).toBe(false);

			const manifestUvUnittest = captureAvoVerificationHarnessManifest(
				tempDir,
				"uv run python3 -m unittest -v test/test_sample.py",
				baseline,
			);

			expect(manifestUvUnittest.runnerFamily).toBe("pytest");
			expect(
				manifestUvUnittest.unsupportedReasons.some((reason) =>
					reason.includes("not a directly resolved closed runner invocation"),
				),
			).toBe(false);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
