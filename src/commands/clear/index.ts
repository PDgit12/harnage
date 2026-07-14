import type { LocalCommandHandler } from "../../commands";

const handler: LocalCommandHandler = {
	async call(): Promise<{ value: string }> {
		return { value: "CLEAR_MESSAGES" };
	},
};

export default handler;
