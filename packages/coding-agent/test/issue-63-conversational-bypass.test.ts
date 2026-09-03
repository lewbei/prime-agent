import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AvoStore, buildAvoRuntimePrompt, isAvoConversationalTurn } from "../src/core/avo/index.js";
import { createHarness } from "./suite/harness.js";

describe("Issue #63: [AVO] Provide direct conversational bypass for greetings and trivial turns", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `avo-issue63-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	describe("1. isAvoConversationalTurn classifier", () => {
		it("identifies standard greetings and pleasantries as conversational", () => {
			expect(isAvoConversationalTurn("hi")).toBe(true);
			expect(isAvoConversationalTurn("Hi!")).toBe(true);
			expect(isAvoConversationalTurn("hello")).toBe(true);
			expect(isAvoConversationalTurn("Hello there")).toBe(true);
			expect(isAvoConversationalTurn("hey")).toBe(true);
			expect(isAvoConversationalTurn("good morning")).toBe(true);
			expect(isAvoConversationalTurn("Good afternoon!")).toBe(true);
			expect(isAvoConversationalTurn("good evening")).toBe(true);
			expect(isAvoConversationalTurn("howdy")).toBe(true);
			expect(isAvoConversationalTurn("yo")).toBe(true);
			expect(isAvoConversationalTurn("how are you?")).toBe(true);
			expect(isAvoConversationalTurn("how are you doing today?")).toBe(true);
			expect(isAvoConversationalTurn("what's up?")).toBe(true);
			expect(isAvoConversationalTurn("nice to meet you")).toBe(true);
		});

		it("identifies acknowledgments and pleasantries as conversational", () => {
			expect(isAvoConversationalTurn("thanks")).toBe(true);
			expect(isAvoConversationalTurn("Thank you!")).toBe(true);
			expect(isAvoConversationalTurn("thanks a lot")).toBe(true);
			expect(isAvoConversationalTurn("thank you very much")).toBe(true);
			expect(isAvoConversationalTurn("ok")).toBe(true);
			expect(isAvoConversationalTurn("Okay")).toBe(true);
			expect(isAvoConversationalTurn("got it")).toBe(true);
			expect(isAvoConversationalTurn("sounds good")).toBe(true);
			expect(isAvoConversationalTurn("cool")).toBe(true);
			expect(isAvoConversationalTurn("great, thanks!")).toBe(true);
			expect(isAvoConversationalTurn("awesome")).toBe(true);
			expect(isAvoConversationalTurn("perfect")).toBe(true);
			expect(isAvoConversationalTurn("understood")).toBe(true);
		});

		it("rejects coding, research, arithmetic, or actionable tasks as non-conversational", () => {
			// Coding tasks
			expect(isAvoConversationalTurn("fix the bug in parser.py")).toBe(false);
			expect(isAvoConversationalTurn("implement user login")).toBe(false);
			expect(isAvoConversationalTurn("run the test suite")).toBe(false);
			expect(isAvoConversationalTurn("build the project")).toBe(false);
			expect(isAvoConversationalTurn("refactor src/core/agent-session.ts")).toBe(false);
			expect(isAvoConversationalTurn("check git status")).toBe(false);
			expect(isAvoConversationalTurn("inspect this repository")).toBe(false);
			expect(isAvoConversationalTurn("hello, please fix parser.py")).toBe(false);

			// Arithmetic / deterministic tasks
			expect(isAvoConversationalTurn("what is 2 + 2?")).toBe(false);
			expect(isAvoConversationalTurn("compute 42 * 100")).toBe(false);

			// External search / factual / research
			expect(isAvoConversationalTurn("search online for latest release")).toBe(false);
			expect(isAvoConversationalTurn("what is the current time?")).toBe(false);
			expect(isAvoConversationalTurn("literature review on RLHF")).toBe(false);

			// Creative generation
			expect(isAvoConversationalTurn("write a poem about rain")).toBe(false);
			expect(isAvoConversationalTurn("create a report on sales")).toBe(false);
		});
	});

	describe("2. AvoStore prompt routing and bypass state", () => {
		it("routes conversational greeting with bypass=true and not_applicable verification policy", () => {
			const store = new AvoStore(tempDir, "run-bypass-test", () => "2026-09-03T00:00:00.000Z", tempDir);
			const state = store.initialize("Hello there!", "Hello there!");

			expect(state.routing.bypass).toBe(true);
			expect(state.routing.environment).toBe("general");
			expect(state.routing.horizon).toBe("direct");
			expect(state.verificationPolicy).toBe("not_applicable");
			expect(state.routing.reasons.some((r) => r.includes("conversational turn bypass"))).toBe(true);
		});

		it("routes actionable coding task with bypass=false/undefined and required verification", () => {
			const store = new AvoStore(tempDir, "run-coding-test", () => "2026-09-03T00:00:00.000Z", tempDir);
			const state = store.initialize("Fix the syntax error in server.ts", "Fix the syntax error in server.ts");

			expect(state.routing.bypass).toBeFalsy();
			expect(state.routing.environment).toBe("coding");
			expect(state.verificationPolicy).toBe("required");
		});

		it("transitions from conversational bypass to coding task across consecutive prompts", () => {
			const store = new AvoStore(tempDir, "run-transition-test", () => "2026-09-03T00:00:00.000Z", tempDir);
			let state = store.initialize("hi", "hi");
			expect(state.routing.bypass).toBe(true);

			// Second turn: actionable work
			store.startTask(
				"Update the README.md with installation steps",
				"Update the README.md with installation steps",
			);
			state = store.getState();
			expect(state.routing.bypass).toBeFalsy();
			expect(state.routing.environment).toBe("coding");
		});
	});

	describe("3. buildAvoRuntimePrompt on bypass turns", () => {
		it("emits lightweight conversational guidance without candidate-cycle obligations", () => {
			const store = new AvoStore(tempDir, "run-prompt-test", () => "2026-09-03T00:00:00.000Z", tempDir);
			const state = store.initialize("Good morning!", "Good morning!");
			const prompt = buildAvoRuntimePrompt(state);

			expect(prompt).toContain("conversational turn");
			expect(prompt).toContain("not required");
			// Should NOT contain the heavy candidate registration instructions
			expect(prompt).not.toContain("AVO provides the variation operator");
			expect(prompt).not.toContain("call `candidate = await avo.add_candidate");
		});
	});

	describe("4. AgentSession live conversational delivery", () => {
		it("allows immediate text greeting delivery without AVO candidate or tool calls", async () => {
			let executions = 0;
			const dummyTool: AgentTool = {
				name: "dummy_tool",
				label: "Dummy",
				description: "Should never be called for greetings",
				parameters: Type.Object({ action: Type.String() }),
				execute: async () => {
					executions += 1;
					return { content: [{ type: "text", text: "executed" }], details: {} };
				},
			};

			const harness = await createHarness({
				persistSession: true,
				enforceAvoCompletion: true,
				tools: [dummyTool],
			});

			harness.setResponses([fauxAssistantMessage("Hello! How can I help you today?", { stopReason: "stop" })]);

			await harness.session.prompt("Hello!");

			expect(executions).toBe(0);

			const getRes = await harness.session.handleAvoHostRequest("avo.get");
			const state = getRes.state as unknown as {
				routing: { bypass?: boolean };
				status: string;
			};
			expect(state.routing.bypass).toBe(true);

			// Turn ended cleanly with no pending continuations or errors
			expect(harness.session.queuedActionCount).toBe(0);
		});

		it("transitions cleanly from a greeting turn to a full AVO task", async () => {
			let toolExecutions = 0;
			const ipythonTool: AgentTool = {
				name: "ipython",
				label: "Python",
				description: "Executes Python",
				parameters: Type.Object({ code: Type.String() }),
				execute: async (_toolCallId, params) => {
					toolExecutions += 1;
					const code = (params as { code: string }).code;
					if (code.includes("add_candidate")) {
						await harness.session.handleAvoHostRequest("avo.candidate.add", {
							candidate: {
								candidate_id: "cand-poem-1",
								kind: "answer",
								summary: "Rain poem",
								payload: "Rain falls softly on the leaves.",
							},
						});
						await harness.session.handleAvoHostRequest("avo.evaluation.record", {
							evaluation: {
								candidate_id: "cand-poem-1",
								evaluator_id: "subjective_review",
								status: "pass",
								authority: "model_opinion",
								evidence_refs: [],
								metrics: { reviewed: true },
							},
						});
						await harness.session.handleAvoHostRequest("avo.cycle.complete", {
							cycle: { candidate_id: "cand-poem-1" },
						});
					}
					return { content: [{ type: "text", text: "ok" }], details: {} };
				},
			};

			const harness = await createHarness({
				persistSession: true,
				enforceAvoCompletion: true,
				tools: [ipythonTool],
			});

			// Turn 1: Greeting (conversational bypass)
			harness.setResponses([fauxAssistantMessage("Hi there! What are you working on?", { stopReason: "stop" })]);
			await harness.session.prompt("Hi!");
			expect(toolExecutions).toBe(0);

			// Verify turn 1 was bypassed
			const state1 = (await harness.session.handleAvoHostRequest("avo.get")).state as unknown as {
				routing: { bypass?: boolean };
			};
			expect(state1.routing.bypass).toBe(true);

			// Turn 2: Non-conversational task (exits bypass and enforces AVO lifecycle)
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("ipython", { code: 'await avo.add_candidate("cand-poem-1")' })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Rain falls softly on the leaves.", { stopReason: "stop" }),
			]);
			await harness.session.prompt("Write a poem about rain");

			expect(toolExecutions).toBe(1);
			const state2 = (await harness.session.handleAvoHostRequest("avo.get")).state as unknown as {
				routing: { bypass?: boolean; environment: string };
				delivery: { phase: string };
			};
			expect(state2.routing.bypass).toBeFalsy();
			expect(state2.delivery.phase).toBe("delivered");
		}, 15_000);
	});
});
