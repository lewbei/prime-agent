import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";

type Harness = {
	_goalState: {
		status: string;
		objective?: string;
		tokensUsed: number;
		tokenBudget?: number;
		continuationsUsed: number;
	};
	_goalAccountedAssistantMessages: Set<unknown>;
	_goalContinuationAwaitsRlmWork: boolean;
	_disposed: boolean;
	_disposing: boolean;
	_enforceAvoCompletion: boolean;
	_avoRuntime?: {
		getState: () => { status: string; routing: { bypass?: boolean }; delivery: { phase: string } };
	};
	_completeAvoCanonicalDeliveryIfMatching: (context: unknown) => Promise<boolean>;
	_pendingAvoCanonicalDelivery: () => unknown;
	_isAvoCanonicalDeliveryTerminalFailure: () => boolean;
	_hasReachedAutonomousLimit: () => boolean;
	_stopGoalContinuationForTerminalMessage: (msg: unknown) => boolean;
	_accountGoalUsageForAssistantMessage: (msg: unknown) => boolean;
	_queuePreparedPrompt: ReturnType<typeof vi.fn>;
	_runSerializedRefineCheckpoint: () => Promise<void>;
	_serializedRefine: boolean;
	_steeringStopPending: boolean;
	_shouldStopForThresholdCompaction: (context: unknown) => Promise<boolean>;
	_agentEventQueue: Promise<void>;
	_getAvoCompletionContinuation: (context: unknown, signal?: unknown) => Promise<unknown>;
	_getGoalContinuationMessages: (context: unknown, signal?: unknown) => Promise<unknown[]>;
	queuedActionCount: number;
	_sessionInputArrivalEpoch: number;
	_autonomousContinuationSuppressionDepth: number;
	_autonomousContinuationSuppressedMessages: Set<unknown>;
	_snapshotAutonomousRuntimeState: () => unknown;
	nextAutonomousContinuation: () => Promise<unknown>;
};

const shouldStopAfterTurn = Reflect.get(AgentSession.prototype, "_shouldStopAfterTurn") as (
	this: Harness,
	context: { message: { role: string; stopReason: string; usage?: unknown } },
) => Promise<boolean>;

const getContinuationMessages = Reflect.get(AgentSession.prototype, "_getContinuationMessages") as (
	this: Harness,
	context: { message: { role: string; stopReason: string }; newMessages: unknown[]; context: unknown },
	signal?: AbortSignal,
) => Promise<unknown[]>;

function createHarness(overrides: Partial<Harness> = {}): Harness {
	return {
		_goalState: { status: "active", objective: "build feature", tokensUsed: 0, continuationsUsed: 0 },
		_goalAccountedAssistantMessages: new Set(),
		_goalContinuationAwaitsRlmWork: false,
		_disposed: false,
		_disposing: false,
		_enforceAvoCompletion: true,
		_avoRuntime: {
			getState: () => ({ status: "active", routing: {}, delivery: { phase: "accepted" } }),
		},
		_completeAvoCanonicalDeliveryIfMatching: vi.fn().mockResolvedValue(true),
		_pendingAvoCanonicalDelivery: () => undefined,
		_isAvoCanonicalDeliveryTerminalFailure: () => false,
		_hasReachedAutonomousLimit: () => false,
		_stopGoalContinuationForTerminalMessage: () => false,
		_accountGoalUsageForAssistantMessage: vi.fn().mockReturnValue(false),
		_queuePreparedPrompt: vi.fn(),
		_runSerializedRefineCheckpoint: vi.fn().mockResolvedValue(undefined),
		_serializedRefine: false,
		_steeringStopPending: false,
		_shouldStopForThresholdCompaction: vi.fn().mockResolvedValue(false),
		_agentEventQueue: Promise.resolve(),
		_getAvoCompletionContinuation: vi.fn().mockResolvedValue(undefined),
		_getGoalContinuationMessages: vi.fn().mockResolvedValue([{ role: "user", content: "continue goal" }]),
		queuedActionCount: 0,
		_sessionInputArrivalEpoch: 1,
		_autonomousContinuationSuppressionDepth: 0,
		_autonomousContinuationSuppressedMessages: new Set(),
		_snapshotAutonomousRuntimeState: () => ({}),
		nextAutonomousContinuation: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

describe("_shouldStopAfterTurn with AVO canonical delivery and goal continuation", () => {
	it("does not stop after canonical delivery when an active goal should continue", async () => {
		const h = createHarness();
		const context = { message: { role: "assistant", stopReason: "stop" } };

		const shouldStop = await shouldStopAfterTurn.call(h, context as any);

		expect(h._completeAvoCanonicalDeliveryIfMatching).toHaveBeenCalledWith(context);
		expect(h._accountGoalUsageForAssistantMessage).toHaveBeenCalledWith(context.message);
		expect(shouldStop).toBe(false);
	});

	it("stops after canonical delivery when no goal is active", async () => {
		const h = createHarness({
			_goalState: { status: "idle", tokensUsed: 0, continuationsUsed: 0 },
		});
		const context = { message: { role: "assistant", stopReason: "stop" } };

		const shouldStop = await shouldStopAfterTurn.call(h, context as any);

		expect(h._completeAvoCanonicalDeliveryIfMatching).toHaveBeenCalledWith(context);
		expect(shouldStop).toBe(true);
	});

	it("stops after canonical delivery if goal budget is exceeded", async () => {
		const h = createHarness({
			_accountGoalUsageForAssistantMessage: vi.fn().mockImplementation(function (this: Harness) {
				h._goalState.status = "budget_limited";
				return true;
			}),
		});
		const context = { message: { role: "assistant", stopReason: "stop" } };

		const shouldStop = await shouldStopAfterTurn.call(h, context as any);

		expect(h._completeAvoCanonicalDeliveryIfMatching).toHaveBeenCalledWith(context);
		expect(h._accountGoalUsageForAssistantMessage).toHaveBeenCalledWith(context.message);
		expect(h._queuePreparedPrompt).toHaveBeenCalled();
		expect(shouldStop).toBe(true);
	});
});

describe("_getContinuationMessages after AVO completion", () => {
	it("returns goal continuation messages when AVO task is completed but goal is active", async () => {
		const h = createHarness({
			_avoRuntime: {
				getState: () => ({ status: "completed", routing: {}, delivery: { phase: "accepted" } }),
			},
		});
		const context = {
			message: { role: "assistant", stopReason: "stop" },
			newMessages: [],
			context: {},
		};

		const messages = await getContinuationMessages.call(h, context as any);

		expect(h._getGoalContinuationMessages).toHaveBeenCalled();
		expect(messages).toEqual([{ role: "user", content: "continue goal" }]);
	});

	it("returns empty array when AVO task is completed and no goal is active", async () => {
		const h = createHarness({
			_goalState: { status: "idle", tokensUsed: 0, continuationsUsed: 0 },
			_avoRuntime: {
				getState: () => ({ status: "completed", routing: {}, delivery: { phase: "accepted" } }),
			},
		});
		const context = {
			message: { role: "assistant", stopReason: "stop" },
			newMessages: [],
			context: {},
		};

		const messages = await getContinuationMessages.call(h, context as any);

		expect(h._getGoalContinuationMessages).not.toHaveBeenCalled();
		expect(messages).toEqual([]);
	});
});
