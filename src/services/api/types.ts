export interface StreamEvent {
	type:
		| "text"
		| "tool_use"
		| "tool_result"
		| "thinking"
		| "error"
		| "done"
		| "permission_request";
	content?: string;
	name?: string;
	input?: Record<string, unknown>;
	id?: string;
	usage?: { promptTokens: number; completionTokens: number };
	toolName?: string;
	toolInput?: Record<string, unknown>;
	resolvePermission?: (allowed: boolean) => void;
}
