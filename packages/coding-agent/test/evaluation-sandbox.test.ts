import { describe, expect, test } from "vitest";
import { buildIsolatedEvaluationSandboxArgs } from "../src/evals/evaluation-sandbox.js";

function argumentIndex(args: readonly string[], option: string, path: string): number {
	return args.findIndex((value, index) => value === option && args[index + 1] === path);
}

describe("isolated evaluation sandbox", () => {
	test("builds a private-home, network-isolated grader profile", () => {
		const args = buildIsolatedEvaluationSandboxArgs({
			command: ["/usr/bin/python3", "-I", "grader.py"],
			cwd: "/work/candidate",
			privateHome: "/home/evaluator",
			writablePaths: ["/work/candidate", "/work/evidence"],
			readOnlyPaths: ["/work/control", "/home/evaluator/.cache/toolchain/runtime"],
			hiddenPaths: ["/official-benchmark", "/home/evaluator/.ssh"],
		});

		expect(args[0]).toBe("bwrap");
		expect(args).toContain("--unshare-net");
		expect(argumentIndex(args, "--tmpfs", "/home/evaluator")).toBeGreaterThan(-1);
		expect(argumentIndex(args, "--tmpfs", "/official-benchmark")).toBeGreaterThan(-1);
		expect(args).not.toContain("/home/evaluator/.ssh");
		expect(argumentIndex(args, "--dir", "/home/evaluator/.cache")).toBeGreaterThan(-1);
		expect(argumentIndex(args, "--dir", "/home/evaluator/.cache/toolchain")).toBeGreaterThan(-1);
		expect(argumentIndex(args, "--bind", "/work/candidate")).toBeGreaterThan(-1);
		expect(argumentIndex(args, "--bind", "/work/evidence")).toBeGreaterThan(-1);
		expect(argumentIndex(args, "--ro-bind", "/work/control")).toBeGreaterThan(-1);
		expect(argumentIndex(args, "--ro-bind", "/home/evaluator/.cache/toolchain/runtime")).toBeGreaterThan(-1);
		expect(args.slice(-4)).toEqual(["--", "/usr/bin/python3", "-I", "grader.py"]);
	});

	test("rejects ambiguous or unbounded mount policies", () => {
		expect(() =>
			buildIsolatedEvaluationSandboxArgs({
				command: ["grader"],
				cwd: "/work",
				privateHome: "/home/evaluator",
				writablePaths: ["relative"],
				readOnlyPaths: [],
			}),
		).toThrow(/writable path must be absolute/);
		expect(() =>
			buildIsolatedEvaluationSandboxArgs({
				command: ["grader"],
				cwd: "/work",
				privateHome: "/home/evaluator",
				writablePaths: ["/work"],
				readOnlyPaths: ["/work"],
			}),
		).toThrow(/both writable and read-only/);
		expect(() =>
			buildIsolatedEvaluationSandboxArgs({
				command: ["grader"],
				cwd: "/work",
				privateHome: "/home/evaluator",
				writablePaths: [],
				readOnlyPaths: ["/home/evaluator"],
			}),
		).toThrow(/cannot expose the complete private home/);
		expect(() =>
			buildIsolatedEvaluationSandboxArgs({
				command: ["grader"],
				cwd: "/work",
				privateHome: "/home/evaluator",
				writablePaths: [],
				readOnlyPaths: ["/home/evaluator/.cache"],
				hiddenPaths: ["/home/evaluator/.cache/credentials"],
			}),
		).toThrow(/would expose hidden path/);
	});
});
