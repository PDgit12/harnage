import type { LocalCommandHandler } from "../../commands";

const handler: LocalCommandHandler = {
	async call(): Promise<{ value: string }> {
		return { value: "EXIT_APP" };
	},
};

export default handler;
