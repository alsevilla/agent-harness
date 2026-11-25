// Approval prompts list No first. Keys typed after a prompt appears go to it, so Enter sent for a message being typed picks the
// highlighted option; with Pi's confirm that is Yes (field report: a merge prompt popped up while the operator was typing).
export async function approve(ctx: { ui: { confirm: (title: string, message: string, opts?: any) => Promise<boolean>; select?: (title: string, options: string[], opts?: any) => Promise<string | undefined> } }, title: string, message: string, opts?: { timeout?: number }): Promise<boolean> {
	if (typeof ctx.ui.select !== "function") return ctx.ui.confirm(title, message, opts);
	return (await ctx.ui.select(`${title}\n${message}`, ["No", "Yes"], opts)) === "Yes";
}
