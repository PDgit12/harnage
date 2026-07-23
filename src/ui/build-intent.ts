// Detect "build me a harness" intent so a plain description runs the BUILDER,
// not the general chat agent (which would just hallucinate a plan telling the
// user to run /init). Conservative on purpose: requires the word "harness"
// plus a build verb, so "explain the harness architecture" (a real chat
// question) stays chat, while "build/make/create/generate a harness that…"
// routes to the builder. Anything starting with "/" is a command, handled
// before this is ever consulted.
export function isBuildIntent(text: string): boolean {
	const t = text.toLowerCase();
	if (!/\bharness(es)?\b/.test(t)) return false;
	return /\b(build|create|make|generate|scaffold|want|need|init|set ?up)\b/.test(
		t,
	);
}
