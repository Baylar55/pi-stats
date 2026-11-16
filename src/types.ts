import type { AssistantMessage, StopReason, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import type { AgentType } from "./shared-types";

export * from "./shared-types";

/**
 * Extracted stats from one usage source: an assistant message, or usage
 * recorded outside one (a `usage` entry, a compaction or branch summary, a
 * tool result).
 */
export interface MessageStats {
	/** Database ID */
	id?: number;
	/** Session file path */
	sessionFile: string;
	/** Entry ID within the session */
	entryId: string;
	/** Folder/project path (the session header's `cwd`) */
	folder: string;
	/** Model ID */
	model: string;
	/** Provider name */
	provider: string;
	/** API type */
	api: string;
	/** Unix timestamp in milliseconds */
	timestamp: number;
	/** Request duration in milliseconds; null when neither the message nor a live timing recorded one */
	duration: number | null;
	/** Time to first token in milliseconds; only live timings supply it, transcripts never do */
	ttft: number | null;
	/** Stop reason */
	stopReason: StopReason;
	/** Error message if stopReason is error */
	errorMessage: string | null;
	/** Token usage */
	usage: Usage;
	/** Which agent produced this message (main agent, nested subagent transcript) */
	agentType: AgentType;
	/**
	 * Ingest could not price this request: it used tokens but recorded no cost
	 * and no rate card prices its model, so `usage.cost.total` of 0 is unknown
	 * spend rather than a free request. Always written by `rowToMessageStats`;
	 * optional only because session fixtures that stand in for ingest input are
	 * typed as `MessageStats` too.
	 */
	costUnpriced?: boolean;
}

/**
 * Session-recorded token usage before pricing: counters are coerced to numbers
 * because their columns are NOT NULL, but `cost` is only present when the
 * session entry actually recorded one, and may be partial in legacy files; the
 * ingest path normalises it and prices a request that recorded none.
 * `costUnpriced` is omitted because it is a decision of the ingest path, not
 * something the parser or a caller supplies.
 */
export interface MessageStatsInput extends Omit<MessageStats, "usage" | "costUnpriced"> {
	usage: Omit<Usage, "cost"> & { cost?: Partial<Usage["cost"]> };
}

/**
 * Full details of a request, including content.
 */
export interface RequestDetails extends MessageStats {
	/** The full conversation history or just the last turn. */
	messages: unknown[];
	/** The model's response; `null` for usage recorded outside an assistant message, which journals no payload. */
	output: unknown;
}

/**
 * Session log entry types. They mirror pi's `SessionManager` shapes
 * structurally: stats never imports the coding agent.
 */
export interface SessionHeader {
	type: "session";
	version?: number;
	id: string;
	timestamp: string;
	cwd: string;
	/** Transcript this session was forked or branched from. */
	parentSession?: string;
}

/** Fields every entry below the header carries (v1 transcripts get them assigned by the parser). */
export interface SessionEntryBase {
	id: string;
	parentId: string | null;
	timestamp: string;
}

/** Message roles the stats do not read: the prompt/tool loadout, extension messages, `!` shell runs. */
export interface SessionOtherMessage {
	role: "system" | "custom" | "bashExecution";
	timestamp?: number;
	[key: string]: unknown;
}

export type SessionMessage = AssistantMessage | ToolResultMessage | UserMessage | SessionOtherMessage;

export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: SessionMessage;
}

/** Model-attributed usage outside an assistant message (`kind` names the operation, e.g. `cache_warm`). */
export interface SessionUsageEntry extends SessionEntryBase {
	type: "usage";
	kind: string;
	provider: string;
	model: string;
	usage: Usage;
	note?: string;
}

/** The user switched models; the latest one is the session's selected model. */
export interface SessionModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface SessionCompactionEntry extends SessionEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Usage of the LLM call(s) that wrote the summary. */
	usage?: Usage;
	details?: unknown;
	fromHook?: boolean;
}

export interface SessionBranchSummaryEntry extends SessionEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	/** Usage of the LLM call that wrote the summary. */
	usage?: Usage;
	details?: unknown;
	fromHook?: boolean;
}

/** Extension state (`customType` names the extension); never part of the LLM context. */
export interface SessionCustomEntry {
	type: "custom";
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	customType: string;
	data?: Record<string, unknown>;
}

/** Extension-injected message that is part of the LLM context. */
export interface SessionCustomMessageEntry extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: unknown;
	display: boolean;
	details?: unknown;
}

/** Session metadata, e.g. the display name set with `/name`. */
export interface SessionInfoEntry extends SessionEntryBase {
	type: "session_info";
	name?: string;
}

/** Structural variants nothing reads a field of beyond the envelope. */
export interface SessionTypedEntry {
	type: "thinking_level_change" | "context_edit" | "label";
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	[key: string]: unknown;
}

export type SessionEntry =
	| SessionHeader
	| SessionMessageEntry
	| SessionUsageEntry
	| SessionModelChangeEntry
	| SessionCompactionEntry
	| SessionBranchSummaryEntry
	| SessionCustomEntry
	| SessionCustomMessageEntry
	| SessionInfoEntry
	| SessionTypedEntry
	| { type: string };

/**
 * Behavioral stats extracted from a single user message.
 */
export interface UserMessageStats {
	/** Database ID */
	id?: number;
	/** Session file path */
	sessionFile: string;
	/** Entry ID within the session */
	entryId: string;
	/** Folder/project path */
	folder: string;
	/** Unix timestamp in ms */
	timestamp: number;
	/** Model that responded to this user message, if linked */
	model: string | null;
	/** Provider that responded to this user message, if linked */
	provider: string | null;
	/** Total characters of message text */
	chars: number;
	/** Whitespace-delimited word count */
	words: number;
	/** Yelling sentences (> 50% uppercase letters) */
	yelling: number;
	/** Profanity hits */
	profanity: number;
	/** Catch-all upset signal: drama runs + `noooo`/`ughh`/... + `dude` + `:(` */
	anguish: number;
	/** Corrective negation ("no", "nope", "thats not what i meant") */
	negation: number;
	/** User repeating themselves ("i meant", "still doesnt work", "like i said") */
	repetition: number;
	/** Second-person reproach ("you didnt", "why did you", "stop X-ing") */
	blame: number;
	/** Judge-facing prose (see `judgeProse`); empty when the message was all markup. */
	prose: string;
	/** `hashHex` of `prose`, keying the shared verdict cache; empty when `prose` is. */
	proseHash: string;
}

/**
 * Pair emitted by the parser for each assistant message that answers a user
 * message: the first assistant message descending from it through non-message
 * entries, whether the user message was parsed in this pass or an earlier one.
 * The aggregator applies the link to the persisted `user_messages` row so it
 * stops showing up in the "unknown" model bucket.
 */
export interface UserMessageLink {
	sessionFile: string;
	entryId: string;
	model: string;
	provider: string;
}

/**
 * One tool call extracted from an assistant message's `toolCall` content
 * blocks. `callsInTurn` records how many calls that assistant turn contained
 * so aggregation can split the turn's real provider usage evenly per call.
 */
export interface ToolCallStats {
	/** Session file path */
	sessionFile: string;
	/** Assistant-message entry ID that emitted the call */
	entryId: string;
	/** Provider-assigned tool call ID (unique within a session) */
	toolCallId: string;
	/** Folder/project path (the session header's `cwd`) */
	folder: string;
	/** Tool name */
	toolName: string;
	/** Model that emitted the call */
	model: string;
	/** Provider name */
	provider: string;
	/** Assistant-message timestamp (Unix ms) */
	timestamp: number;
	/** Which agent produced the call */
	agentType: AgentType;
	/** Total tool calls in the same assistant turn (>= 1) */
	callsInTurn: number;
	/** Serialized argument characters */
	argsChars: number;
	/** Result text characters, when the same parse also read the call's `toolResult` */
	resultChars?: number;
	/** Result error flag, set together with `resultChars` */
	isError?: boolean;
}

/**
 * Result linkage emitted when the parser sees a `toolResult` message entry.
 * Applied as an UPDATE on the persisted tool-call row — results can land in a
 * later incremental sync pass than the call that produced them (calls parsed
 * in the same pass already carry the result, so their UPDATE is a no-op).
 */
export interface ToolResultLink {
	sessionFile: string;
	toolCallId: string;
	/** Text characters fed back into context */
	resultChars: number;
	isError: boolean;
}
